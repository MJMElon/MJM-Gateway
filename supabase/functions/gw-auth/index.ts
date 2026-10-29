// 登录与密码（原本在 Next.js 服务端执行，改为 Edge Function 以支持静态网站）
// POST { action: "login", email, password }
//   → { session, must_change_password, locale } 或 { error, remaining?, minutes? }
//   连续输错 5 次锁 15 分钟；帐号必须有启用中的 Gateway 资料
// POST { action: "password_changed" }（带用户 Token）→ 清除「必须改密码」标记并记录
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, getCaller, json, logEvent, serviceClient } from "../_shared/gw.ts";

const minutesUntil = (iso: string) => Math.max(1, Math.ceil((new Date(iso).getTime() - Date.now()) / 60000));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const body = await req.json().catch(() => ({}));
  const admin = serviceClient();

  if (body.action === "login") {
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    if (!email || !password) return json({ error: "invalid" });

    const { data: lockedUntil } = await admin.rpc("gw_login_locked_until", { p_email: email });
    if (lockedUntil) return json({ error: "locked", minutes: minutesUntil(lockedUntil) });

    const auth = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await auth.auth.signInWithPassword({ email, password });

    if (error || !data.session) {
      if (error?.code === "user_banned") return json({ error: "disabled" });
      const { data: result } = await admin.rpc("gw_login_failed", { p_email: email });
      await logEvent(null, "auth.login_failed", "auth", null, email);
      if (result?.locked_until) {
        await logEvent(null, "auth.locked", "auth", null, email, { minutes: 15 });
        return json({ error: "locked", minutes: 15 });
      }
      return json({ error: "invalid", remaining: result?.remaining });
    }

    await admin.rpc("gw_login_succeeded", { p_email: email });
    const { data: profile } = await admin
      .from("gw_profiles")
      .select("status, must_change_password, locale")
      .eq("id", data.user.id)
      .maybeSingle();
    if (!profile || profile.status !== "active") {
      await admin.auth.admin.signOut(data.session.access_token).catch(() => {});
      return json({ error: profile ? "disabled" : "no_access" });
    }

    await logEvent(data.user.id, "auth.login", "auth", data.user.id, email);
    return json({
      session: { access_token: data.session.access_token, refresh_token: data.session.refresh_token },
      must_change_password: profile.must_change_password,
      locale: profile.locale,
    });
  }

  if (body.action === "password_changed") {
    const caller = await getCaller(req);
    if (!caller) return json({ error: "unauthorized" }, 401);
    await admin.from("gw_profiles").update({ must_change_password: false }).eq("id", caller.user.id);
    await logEvent(caller.user.id, "auth.password_changed", "auth", caller.user.id, caller.user.email ?? null);
    return json({ ok: true });
  }

  return json({ error: "unknown_action" }, 400);
});
