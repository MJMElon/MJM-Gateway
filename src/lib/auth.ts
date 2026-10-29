import "server-only";
import { redirect } from "next/navigation";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import type { Profile } from "@/lib/types";

// 当前登录用户 + Gateway 资料（同一次请求内只查一次）
export const getCurrentProfile = cache(async (): Promise<Profile | null> => {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await supabase.from("gw_profiles").select("*").eq("id", user.id).maybeSingle();
  return (data as Profile | null) ?? null;
});

// 已登录、帐号启用、已改过初始密码
export async function requireProfile(): Promise<Profile> {
  const profile = await getCurrentProfile();
  if (!profile || profile.status !== "active") redirect("/login?error=no_access");
  if (profile.must_change_password) redirect("/change-password");
  return profile;
}

export async function requireAdmin(): Promise<Profile> {
  const profile = await requireProfile();
  if (profile.role !== "super_admin" && profile.role !== "admin") redirect("/");
  return profile;
}

export async function requireSuperAdmin(): Promise<Profile> {
  const profile = await requireProfile();
  if (profile.role !== "super_admin") redirect("/admin");
  return profile;
}

// 服务端动作用：不 redirect，权限不足直接丢错误
export async function assertAdmin(): Promise<Profile> {
  const profile = await getCurrentProfile();
  if (!profile || profile.status !== "active" || (profile.role !== "super_admin" && profile.role !== "admin")) {
    throw new Error("forbidden");
  }
  return profile;
}
