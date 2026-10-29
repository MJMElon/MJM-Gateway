import { getTranslations } from "next-intl/server";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { Department, Group, Profile } from "@/lib/types";
import { UsersManager } from "@/components/admin/users-manager";

export async function generateMetadata() {
  const t = await getTranslations("admin.tabs");
  return { title: t("users") };
}

export default async function UsersPage() {
  const me = await requireAdmin();
  const supabase = await createClient();
  // RLS：super_admin 看全部，admin 只看到本部门
  const [{ data: users }, { data: departments }, { data: groups }, { data: members }] = await Promise.all([
    supabase.from("gw_profiles").select("*").order("created_at", { ascending: false }),
    supabase.from("gw_departments").select("id, code, name").order("code"),
    supabase.from("gw_groups").select("*").order("sort_order").order("name"),
    supabase.from("gw_group_members").select("group_id, user_id"),
  ]);

  return (
    <UsersManager
      me={me}
      users={(users ?? []) as Profile[]}
      departments={(departments ?? []) as Department[]}
      groups={(groups ?? []) as Group[]}
      members={members ?? []}
    />
  );
}
