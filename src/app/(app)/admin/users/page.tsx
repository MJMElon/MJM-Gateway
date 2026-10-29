"use client";

import { useAuth } from "@/components/auth-provider";
import { Spinner } from "@/components/guards";
import { UsersManager } from "@/components/admin/users-manager";
import { createClient } from "@/lib/supabase/client";
import type { Department, Group, Profile } from "@/lib/types";
import { useLoad } from "@/lib/use-load";

export default function UsersPage() {
  const { profile } = useAuth();
  // RLS：super_admin 看全部，admin 只看到本部门
  const { data, reload } = useLoad(async () => {
    const supabase = createClient();
    const [users, departments, groups, members] = await Promise.all([
      supabase.from("gw_profiles").select("*").order("created_at", { ascending: false }),
      supabase.from("gw_departments").select("id, code, name").order("code"),
      supabase.from("gw_groups").select("*").order("sort_order").order("name"),
      supabase.from("gw_group_members").select("group_id, user_id"),
    ]);
    return {
      users: (users.data ?? []) as Profile[],
      departments: (departments.data ?? []) as Department[],
      groups: (groups.data ?? []) as Group[],
      members: members.data ?? [],
    };
  });
  if (!data || !profile) return <Spinner />;
  return <UsersManager me={profile} {...data} onChange={reload} />;
}
