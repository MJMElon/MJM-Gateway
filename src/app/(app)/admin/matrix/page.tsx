"use client";

import { useAuth } from "@/components/auth-provider";
import { Spinner } from "@/components/guards";
import { PermissionMatrix } from "@/components/admin/permission-matrix";
import { createClient } from "@/lib/supabase/client";
import type { Department, Group, Module, Profile } from "@/lib/types";
import { useLoad } from "@/lib/use-load";

export default function MatrixPage() {
  const { profile } = useAuth();
  const { data } = useLoad(async () => {
    const supabase = createClient();
    const [modules, groups, users, grants, overrides, members, departments] = await Promise.all([
      supabase.from("gw_modules").select("*").order("sort_order").order("name"),
      supabase.from("gw_groups").select("*").order("sort_order").order("name"),
      supabase.from("gw_profiles").select("*").eq("status", "active").order("full_name"),
      supabase.from("gw_group_modules").select("group_id, module_id"),
      supabase.from("gw_user_module_overrides").select("user_id, module_id, effect"),
      supabase.from("gw_group_members").select("group_id, user_id"),
      supabase.from("gw_departments").select("id, code, name").order("code"),
    ]);
    const userIds = (users.data ?? []).map((u) => u.id);
    const effective = userIds.length ? (await supabase.rpc("gw_admin_effective", { p_users: userIds })).data : [];
    return {
      modules: (modules.data ?? []) as Module[],
      groups: (groups.data ?? []) as Group[],
      users: (users.data ?? []) as Profile[],
      departments: (departments.data ?? []) as Department[],
      grants: grants.data ?? [],
      overrides: (overrides.data ?? []) as { user_id: string; module_id: string; effect: "allow" | "deny" }[],
      members: members.data ?? [],
      effective: (effective ?? []) as { user_id: string; module_id: string }[],
    };
  });
  if (!data || !profile) return <Spinner />;
  return <PermissionMatrix me={profile} {...data} />;
}
