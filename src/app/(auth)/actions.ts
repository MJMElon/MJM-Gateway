"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { isLocale, LOCALE_COOKIE } from "@/i18n/config";
import { logEvent } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type LoginState = { error?: "invalid" | "locked" | "no_access" | "disabled" | "unknown"; remaining?: number; minutes?: number; email?: string };

function minutesUntil(iso: string) {
  return Math.max(1, Math.ceil((new Date(iso).getTime() - Date.now()) / 60000));
}

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "invalid", email };

  const admin = createAdminClient();

  // 1. 已锁定：不尝试登录
  const { data: lockedUntil } = await admin.rpc("gw_login_locked_until", { p_email: email });
  if (lockedUntil) return { error: "locked", minutes: minutesUntil(lockedUntil), email };

  // 2. 登录
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error || !data.user) {
    if (error?.code === "user_banned") return { error: "disabled", email };
    const { data: result } = await admin.rpc("gw_login_failed", { p_email: email });
    await logEvent(null, "auth.login_failed", "auth", null, email);
    if (result?.locked_until) {
      await logEvent(null, "auth.locked", "auth", null, email, { minutes: 15 });
      return { error: "locked", minutes: 15, email };
    }
    return { error: "invalid", remaining: result?.remaining ?? undefined, email };
  }

  await admin.rpc("gw_login_succeeded", { p_email: email });

  // 3. 必须有启用中的 Gateway 帐号
  const { data: profile } = await supabase
    .from("gw_profiles")
    .select("status, must_change_password, locale")
    .eq("id", data.user.id)
    .maybeSingle();
  if (!profile || profile.status !== "active") {
    await supabase.auth.signOut();
    return { error: profile ? "disabled" : "no_access", email };
  }

  await logEvent(data.user.id, "auth.login", "auth", data.user.id, email);
  if (isLocale(profile.locale)) {
    (await cookies()).set(LOCALE_COOKIE, profile.locale, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
  }
  redirect(profile.must_change_password ? "/change-password" : "/");
}

export async function logout() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

export type ForgotState = { sent?: boolean };

export async function forgotPassword(_prev: ForgotState, formData: FormData): Promise<ForgotState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (email) {
    const origin = process.env.NEXT_PUBLIC_SITE_URL ?? (await headers()).get("origin") ?? "";
    const supabase = await createClient();
    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${origin}/auth/callback?next=${encodeURIComponent("/change-password?reset=1")}`,
    });
  }
  // 不论 email 是否存在都显示相同结果，避免泄漏帐号
  return { sent: true };
}

export type PasswordState = { error?: "too_short" | "mismatch" | "weak" | "same" | "unknown"; ok?: boolean };

export async function changePassword(_prev: PasswordState, formData: FormData): Promise<PasswordState> {
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  if (password.length < 8) return { error: "too_short" };
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return { error: "weak" };
  if (password !== confirm) return { error: "mismatch" };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { error } = await supabase.auth.updateUser({ password });
  if (error) return { error: error.code === "same_password" ? "same" : "unknown" };

  await createAdminClient().from("gw_profiles").update({ must_change_password: false }).eq("id", user.id);
  await logEvent(user.id, "auth.password_changed", "auth", user.id, user.email);
  return { ok: true };
}
