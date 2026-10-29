"use client";

import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import type { Profile } from "@/lib/types";
import { useAuth } from "./auth-provider";

export function Spinner() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center">
      <div className="size-7 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600" />
    </div>
  );
}

type Need = "user" | "admin" | "super";

function allowed(profile: Profile, need: Need) {
  if (need === "super") return profile.role === "super_admin";
  if (need === "admin") return profile.role === "super_admin" || profile.role === "admin";
  return true;
}

// 页面层的导航保护（真正的权限检查在数据库 RLS）：
// 未登录 → 登录页；帐号停用或没有 Gateway 资料 → 登录页；未改初始密码 → 改密码页；权限不足 → 首页
export function RequireProfile({ need = "user", children }: { need?: Need; children: (profile: Profile) => ReactNode }) {
  const { loading, user, profile, signOut } = useAuth();
  const router = useRouter();

  const target = (() => {
    if (loading) return null;
    if (!user) return "/login/";
    if (!profile || profile.status !== "active") return "/login/?error=no_access";
    if (profile.must_change_password) return "/change-password/";
    if (!allowed(profile, need)) return need === "super" ? "/admin/users/" : "/";
    return null;
  })();

  useEffect(() => {
    if (!target) return;
    if (target.startsWith("/login/?error") && user) signOut();
    router.replace(target);
  }, [target, router, user, signOut]);

  if (loading || target || !profile) return <Spinner />;
  return <>{children(profile)}</>;
}
