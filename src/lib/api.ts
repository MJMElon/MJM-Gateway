"use client";

import { createClient } from "@/lib/supabase/client";
import type { Role } from "@/lib/types";

// 调用 Edge Function；回传 JSON（含错误时的 JSON）
async function invoke<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await createClient().functions.invoke<T>(name, { body });
  if (error) {
    const context = (error as { context?: Response }).context;
    if (context && typeof context.json === "function") {
      try {
        return (await context.json()) as T;
      } catch {
        // 不是 JSON
      }
    }
    return { ok: false, error: "network" } as T;
  }
  return data as T;
}

// ------------------------------------------------------------------ 登录 / 密码

export type LoginResult = {
  error?: "invalid" | "locked" | "no_access" | "disabled" | "unknown";
  remaining?: number;
  minutes?: number;
  must_change_password?: boolean;
};

export async function login(email: string, password: string): Promise<LoginResult> {
  const r = await invoke<LoginResult & { session?: { access_token: string; refresh_token: string } }>("gw-auth", {
    action: "login",
    email,
    password,
  });
  if (!r.session) return { error: r.error ?? "unknown", remaining: r.remaining, minutes: r.minutes };
  const { error } = await createClient().auth.setSession(r.session);
  if (error) return { error: "unknown" };
  return { must_change_password: r.must_change_password };
}

export type PasswordError = "too_short" | "mismatch" | "weak" | "same" | "unknown";

export async function changePassword(password: string, confirm: string): Promise<{ error?: PasswordError }> {
  if (password.length < 8) return { error: "too_short" };
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return { error: "weak" };
  if (password !== confirm) return { error: "mismatch" };
  const { error } = await createClient().auth.updateUser({ password });
  if (error) return { error: error.code === "same_password" ? "same" : "unknown" };
  await invoke("gw-auth", { action: "password_changed" });
  return {};
}

// ------------------------------------------------------------------ 后台

export type UserError = "invalid_input" | "forbidden" | "exists" | "auth_failed" | "unknown_department" | "unknown_group";
export type CreateUserResult =
  | { ok: true; email: string; password?: string; linked?: boolean }
  | { ok: false; email: string; error: UserError };

export function createUser(user: {
  email: string;
  full_name: string;
  department_id: string | null;
  role: Role;
  group_ids: string[];
}) {
  return invoke<CreateUserResult>("gw-admin", { action: "create_user", user });
}

export function importUsers(rows: { email: string; full_name: string; department_code: string; groups: string[]; role: string }[]) {
  return invoke<{ results: CreateUserResult[]; error?: "too_many" }>("gw-admin", { action: "import_users", rows });
}

export function setUserStatus(id: string, status: "active" | "disabled") {
  return invoke<{ ok: boolean; error?: UserError }>("gw-admin", { action: "set_status", id, status });
}

export function resetUserPassword(id: string) {
  return invoke<{ ok: true; password: string } | { ok: false; error: UserError }>("gw-admin", { action: "reset_password", id });
}

export function generateApiKey(moduleId: string) {
  return invoke<{ ok: true; key: string } | { ok: false }>("gw-admin", { action: "generate_api_key", module_id: moduleId });
}

export function listApiKeys() {
  return invoke<{ ok: boolean; keys?: { module_id: string; key_prefix: string }[] }>("gw-admin", { action: "list_api_keys" });
}

// 编辑用户（直接以用户身份写入，RLS 与 gw_profiles_guard 检查权限）
export async function updateUser(
  id: string,
  input: { full_name: string; department_id: string | null; role: Role; group_ids: string[] },
): Promise<{ ok: boolean; error?: UserError }> {
  const supabase = createClient();
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
  return { ok: true };
}

// ------------------------------------------------------------------ Excel（只在需要时载入 exceljs）

export async function downloadXlsx(filename: string, build: (workbook: import("exceljs").Workbook) => void) {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  build(workbook);
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export async function readXlsxRows(file: File): Promise<string[][] | null> {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(await file.arrayBuffer());
  } catch {
    return null;
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) return null;
  const rows: string[][] = [];
  sheet.eachRow((row, n) => {
    if (n === 1) return;
    const cells: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const v = row.getCell(i).value;
      cells.push(v && typeof v === "object" && "text" in v ? String(v.text).trim() : v == null ? "" : String(v).trim());
    }
    rows.push(cells);
  });
  return rows;
}
