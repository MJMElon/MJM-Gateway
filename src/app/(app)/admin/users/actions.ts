"use server";

import ExcelJS from "exceljs";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertAdmin } from "@/lib/auth";
import { logEvent } from "@/lib/audit";
import { generatePassword } from "@/lib/password";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { Role } from "@/lib/types";

const createSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  full_name: z.string().trim().min(1).max(100),
  department_id: z.string().uuid().nullable(),
  role: z.enum(["super_admin", "admin", "user"]).default("user"),
  group_ids: z.array(z.string().uuid()).default([]),
  password: z.string().min(8).optional(),
});

export type CreateUserInput = z.input<typeof createSchema>;
export type CreateUserResult =
  | { ok: true; email: string; password?: string; linked?: boolean }
  | { ok: false; email: string; error: string };

// 建立用户：
//  1. 检查调用者权限（admin 只能在本部门建立一般用户）
//  2. 用 service_role 建立 Supabase Auth 帐号（email 已存在就连结现有帐号）
//  3. 以调用者身份写入 gw_profiles —— RLS 再检查一次
export async function createUser(input: CreateUserInput): Promise<CreateUserResult> {
  const caller = await assertAdmin();
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false, email: String(input.email ?? ""), error: "invalid_input" };
  const data = parsed.data;

  if (caller.role === "admin" && (data.role !== "user" || data.department_id !== caller.department_id)) {
    return { ok: false, email: data.email, error: "forbidden" };
  }

  const admin = createAdminClient();
  const supabase = await createClient();

  const { data: existingProfile } = await admin.from("gw_profiles").select("id").ilike("email", data.email).maybeSingle();
  if (existingProfile) return { ok: false, email: data.email, error: "exists" };

  let userId: string;
  let password: string | undefined;
  let linked = false;
  const { data: existingAuthId } = await admin.rpc("gw_auth_user_id", { p_email: data.email });

  if (existingAuthId) {
    userId = existingAuthId;
    linked = true;
  } else {
    password = data.password ?? generatePassword();
    const { data: created, error } = await admin.auth.admin.createUser({ email: data.email, password, email_confirm: true });
    if (error || !created.user) return { ok: false, email: data.email, error: "auth_failed" };
    userId = created.user.id;
  }

  const { error: profileError } = await supabase.from("gw_profiles").insert({
    id: userId,
    email: data.email,
    full_name: data.full_name,
    department_id: data.department_id,
    role: data.role,
    must_change_password: !linked,
  });
  if (profileError) {
    if (!linked) await admin.auth.admin.deleteUser(userId);
    return { ok: false, email: data.email, error: "forbidden" };
  }

  if (data.group_ids.length) {
    await supabase.from("gw_group_members").insert(data.group_ids.map((group_id) => ({ group_id, user_id: userId })));
  }

  await logEvent(caller.id, linked ? "user.link" : "user.create", "profiles", userId, data.email);
  revalidatePath("/admin/users");
  return { ok: true, email: data.email, password, linked };
}

export async function updateUser(
  id: string,
  input: { full_name: string; department_id: string | null; role: Role; group_ids: string[] },
) {
  await assertAdmin();
  const supabase = await createClient();

  const { data: current } = await supabase.from("gw_profiles").select("full_name, department_id, role").eq("id", id).single();
  if (!current) return { ok: false, error: "forbidden" };

  const patch: Record<string, unknown> = {};
  if (input.full_name.trim() && input.full_name.trim() !== current.full_name) patch.full_name = input.full_name.trim();
  if (input.department_id !== current.department_id) patch.department_id = input.department_id;
  if (input.role !== current.role) patch.role = input.role;
  if (Object.keys(patch).length) {
    const { data: updated, error } = await supabase.from("gw_profiles").update(patch).eq("id", id).select("id");
    if (error || !updated?.length) return { ok: false, error: "forbidden" };
  }

  // 群组：只改调用者看得到的群组
  const { data: visibleGroups } = await supabase.from("gw_groups").select("id");
  const visible = new Set((visibleGroups ?? []).map((g) => g.id));
  const { data: memberships } = await supabase.from("gw_group_members").select("group_id").eq("user_id", id);
  const currentGroups = new Set((memberships ?? []).map((m) => m.group_id).filter((g) => visible.has(g)));
  const wanted = new Set(input.group_ids.filter((g) => visible.has(g)));
  const toAdd = [...wanted].filter((g) => !currentGroups.has(g));
  const toRemove = [...currentGroups].filter((g) => !wanted.has(g));

  if (toAdd.length) {
    const { error } = await supabase.from("gw_group_members").insert(toAdd.map((group_id) => ({ group_id, user_id: id })));
    if (error) return { ok: false, error: "forbidden" };
  }
  if (toRemove.length) {
    const { error } = await supabase.from("gw_group_members").delete().eq("user_id", id).in("group_id", toRemove);
    if (error) return { ok: false, error: "forbidden" };
  }

  revalidatePath("/admin/users");
  return { ok: true };
}

export async function setUserStatus(id: string, status: "active" | "disabled") {
  const caller = await assertAdmin();
  const supabase = await createClient();
  const { data: updated, error } = await supabase.from("gw_profiles").update({ status }).eq("id", id).select("id, email");
  if (error || !updated?.length) return { ok: false, error: "forbidden" };

  // 同时封锁 / 解封 Supabase 登录，现有 session 也无法再刷新
  const admin = createAdminClient();
  await admin.auth.admin.updateUserById(id, { ban_duration: status === "disabled" ? "876000h" : "none" });
  await logEvent(caller.id, status === "disabled" ? "user.disable" : "user.enable", "profiles", id, updated[0].email);
  revalidatePath("/admin/users");
  return { ok: true };
}

export async function resetUserPassword(id: string) {
  const caller = await assertAdmin();
  const supabase = await createClient();
  const { data: allowed } = await supabase.rpc("gw_can_manage_user", { p_user: id });
  if (!allowed) return { ok: false as const, error: "forbidden" };

  const admin = createAdminClient();
  const password = generatePassword();
  const { error } = await admin.auth.admin.updateUserById(id, { password });
  if (error) return { ok: false as const, error: "auth_failed" };
  const { data: profile } = await admin
    .from("gw_profiles")
    .update({ must_change_password: true })
    .eq("id", id)
    .select("email")
    .single();
  // 重设密码同时解除登录锁定
  if (profile) await admin.rpc("gw_login_succeeded", { p_email: profile.email });
  await logEvent(caller.id, "user.reset_password", "profiles", id, profile?.email);
  return { ok: true as const, password };
}

// Excel 批量导入：栏位 email / 姓名 / 部门代码 / 群组（逗号分隔）/ 角色（可空）
export async function importUsers(formData: FormData): Promise<{ results: CreateUserResult[]; error?: string }> {
  const caller = await assertAdmin();
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { results: [], error: "no_file" };

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(await file.arrayBuffer());
  } catch {
    return { results: [], error: "bad_file" };
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) return { results: [], error: "bad_file" };

  const supabase = await createClient();
  const [{ data: departments }, { data: groups }] = await Promise.all([
    supabase.from("gw_departments").select("id, code"),
    supabase.from("gw_groups").select("id, name"),
  ]);
  const deptByCode = new Map((departments ?? []).map((d) => [d.code.toUpperCase(), d.id]));
  const groupByName = new Map((groups ?? []).map((g) => [g.name.trim(), g.id]));

  const cell = (row: ExcelJS.Row, i: number) => {
    const v = row.getCell(i).value;
    if (v && typeof v === "object" && "text" in v) return String(v.text).trim();
    return v == null ? "" : String(v).trim();
  };

  const results: CreateUserResult[] = [];
  const rows: ExcelJS.Row[] = [];
  sheet.eachRow((row, n) => n > 1 && rows.push(row));
  if (rows.length > 500) return { results: [], error: "too_many" };

  for (const row of rows) {
    const email = cell(row, 1);
    if (!email) continue;
    const deptCode = cell(row, 3).toUpperCase();
    const groupNames = cell(row, 4).split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    const role = (cell(row, 5) || "user") as Role;

    const departmentId = deptCode ? deptByCode.get(deptCode) ?? "missing" : caller.role === "admin" ? caller.department_id : null;
    const groupIds = groupNames.map((n) => groupByName.get(n));
    if (departmentId === "missing") {
      results.push({ ok: false, email, error: "unknown_department" });
      continue;
    }
    if (groupIds.some((g) => !g)) {
      results.push({ ok: false, email, error: "unknown_group" });
      continue;
    }
    results.push(
      await createUser({
        email,
        full_name: cell(row, 2) || email,
        department_id: departmentId,
        role,
        group_ids: groupIds as string[],
      }),
    );
  }
  return { results };
}
