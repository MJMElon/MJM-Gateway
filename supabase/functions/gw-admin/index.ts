// 后台管理动作（需要 service_role 的部分）：建立用户、批量导入、停用/启用、重设密码、产生模块 API Key
// 每个动作都先以调用者身份检查权限；写入 gw_profiles / gw_group_members 时也用调用者身份，RLS 再检查一次
import { corsHeaders, generatePassword, getCaller, json, logEvent, serviceClient, sha256Hex } from "../_shared/gw.ts";

type Role = "super_admin" | "admin" | "user";
type Caller = NonNullable<Awaited<ReturnType<typeof getCaller>>>;
type CreateInput = { email: string; full_name: string; department_id: string | null; role?: Role; group_ids?: string[] };
type CreateResult = { ok: true; email: string; password?: string; linked?: boolean } | { ok: false; email: string; error: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES: Role[] = ["super_admin", "admin", "user"];

async function createUser(caller: Caller, input: CreateInput): Promise<CreateResult> {
  const email = String(input.email ?? "").trim().toLowerCase();
  const fullName = String(input.full_name ?? "").trim();
  const role: Role = ROLES.includes(input.role as Role) ? (input.role as Role) : "user";
  const groupIds = Array.isArray(input.group_ids) ? input.group_ids : [];
  if (!EMAIL.test(email) || !fullName || fullName.length > 100) return { ok: false, email, error: "invalid_input" };

  const me = caller.profile;
  if (me.role === "admin" && (role !== "user" || input.department_id !== me.department_id)) {
    return { ok: false, email, error: "forbidden" };
  }

  const admin = serviceClient();
  const { data: existing } = await admin.from("gw_profiles").select("id").ilike("email", email).maybeSingle();
  if (existing) return { ok: false, email, error: "exists" };

  let userId: string;
  let password: string | undefined;
  let linked = false;
  const { data: authId } = await admin.rpc("gw_auth_user_id", { p_email: email });
  if (authId) {
    userId = authId;
    linked = true;
  } else {
    password = generatePassword();
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) return { ok: false, email, error: "auth_failed" };
    userId = data.user.id;
  }

  const { error: profileError } = await caller.supabase.from("gw_profiles").insert({
    id: userId,
    email,
    full_name: fullName,
    department_id: input.department_id,
    role,
    must_change_password: !linked,
  });
  if (profileError) {
    if (!linked) await admin.auth.admin.deleteUser(userId);
    return { ok: false, email, error: "forbidden" };
  }
  if (groupIds.length) {
    await caller.supabase.from("gw_group_members").insert(groupIds.map((group_id) => ({ group_id, user_id: userId })));
  }
  await logEvent(me.id, linked ? "user.link" : "user.create", "profiles", userId, email);
  return { ok: true, email, password, linked };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const caller = await getCaller(req);
  const me = caller?.profile;
  if (!caller || !me || me.status !== "active" || (me.role !== "super_admin" && me.role !== "admin")) {
    return json({ ok: false, error: "forbidden" }, 403);
  }
  const body = await req.json().catch(() => ({}));
  const admin = serviceClient();

  switch (body.action) {
    case "create_user":
      return json(await createUser(caller, body.user ?? {}));

    // 批量导入：rows = [{ email, full_name, department_code, groups: [群组名称], role }]
    case "import_users": {
      const rows = Array.isArray(body.rows) ? body.rows : [];
      if (rows.length > 500) return json({ results: [], error: "too_many" });
      const [{ data: departments }, { data: groups }] = await Promise.all([
        caller.supabase.from("gw_departments").select("id, code"),
        caller.supabase.from("gw_groups").select("id, name"),
      ]);
      const deptByCode = new Map((departments ?? []).map((d) => [String(d.code).toUpperCase(), d.id]));
      const groupByName = new Map((groups ?? []).map((g) => [String(g.name).trim(), g.id]));
      const results: CreateResult[] = [];
      for (const row of rows) {
        const email = String(row.email ?? "").trim();
        if (!email) continue;
        const code = String(row.department_code ?? "").trim().toUpperCase();
        const departmentId = code ? deptByCode.get(code) : me.role === "admin" ? me.department_id : null;
        if (code && !departmentId) {
          results.push({ ok: false, email, error: "unknown_department" });
          continue;
        }
        const names: string[] = Array.isArray(row.groups) ? row.groups : [];
        const groupIds = names.map((n) => groupByName.get(String(n).trim()));
        if (groupIds.some((g) => !g)) {
          results.push({ ok: false, email, error: "unknown_group" });
          continue;
        }
        results.push(
          await createUser(caller, {
            email,
            full_name: String(row.full_name ?? "").trim() || email,
            department_id: departmentId ?? null,
            role: (String(row.role ?? "").trim() || "user") as Role,
            group_ids: groupIds as string[],
          }),
        );
      }
      return json({ results });
    }

    case "set_status": {
      const status = body.status === "disabled" ? "disabled" : "active";
      const { data: updated, error } = await caller.supabase
        .from("gw_profiles")
        .update({ status })
        .eq("id", body.id)
        .select("id, email");
      if (error || !updated?.length) return json({ ok: false, error: "forbidden" });
      // 同时封锁 / 解封 Supabase 登录，现有 session 也无法再刷新
      await admin.auth.admin.updateUserById(body.id, { ban_duration: status === "disabled" ? "876000h" : "none" });
      await logEvent(me.id, status === "disabled" ? "user.disable" : "user.enable", "profiles", body.id, updated[0].email);
      return json({ ok: true });
    }

    case "reset_password": {
      const { data: allowed } = await caller.supabase.rpc("gw_can_manage_user", { p_user: body.id });
      if (!allowed) return json({ ok: false, error: "forbidden" });
      const password = generatePassword();
      const { error } = await admin.auth.admin.updateUserById(body.id, { password });
      if (error) return json({ ok: false, error: "auth_failed" });
      const { data: profile } = await admin
        .from("gw_profiles")
        .update({ must_change_password: true })
        .eq("id", body.id)
        .select("email")
        .single();
      // 重设密码同时解除登录锁定
      if (profile) await admin.rpc("gw_login_succeeded", { p_email: profile.email });
      await logEvent(me.id, "user.reset_password", "profiles", body.id, profile?.email ?? null);
      return json({ ok: true, password });
    }

    // 产生目标系统调用 gw-check-access 用的 API Key；只显示一次，资料库只存 SHA-256
    case "generate_api_key": {
      if (me.role !== "super_admin") return json({ ok: false, error: "forbidden" });
      const bytes = crypto.getRandomValues(new Uint8Array(24));
      const key = "gwk_" + btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const { error } = await admin.from("gw_module_api_keys").upsert({
        module_id: body.module_id,
        key_hash: await sha256Hex(key),
        key_prefix: key.slice(0, 10),
        created_at: new Date().toISOString(),
      });
      if (error) return json({ ok: false, error: "forbidden" });
      await logEvent(me.id, "module.api_key", "modules", body.module_id, key.slice(0, 10));
      return json({ ok: true, key });
    }

    // 模块 API Key 前缀（列表显示用）
    case "list_api_keys": {
      if (me.role !== "super_admin") return json({ ok: false, error: "forbidden" });
      const { data } = await admin.from("gw_module_api_keys").select("module_id, key_prefix");
      return json({ ok: true, keys: data ?? [] });
    }
  }
  return json({ ok: false, error: "unknown_action" }, 400);
});
