import { getTranslations } from "next-intl/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { Department, Group } from "@/lib/types";
import { GroupsManager } from "@/components/admin/groups-manager";

export async function generateMetadata() {
  const t = await getTranslations("admin.tabs");
  return { title: t("groups") };
}

export default async function GroupsPage() {
  await requireSuperAdmin();
  const supabase = await createClient();
  const [{ data: groups }, { data: departments }, { data: members }, { data: grants }] = await Promise.all([
    supabase.from("gw_groups").select("*").order("sort_order").order("name"),
    supabase.from("gw_departments").select("id, code, name").order("code"),
    supabase.from("gw_group_members").select("group_id"),
    supabase.from("gw_group_modules").select("group_id"),
  ]);
  const count = (rows: { group_id: string }[] | null) =>
    (rows ?? []).reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.group_id]: (acc[r.group_id] ?? 0) + 1 }), {});

  return (
    <GroupsManager
      groups={(groups ?? []) as Group[]}
      departments={(departments ?? []) as Department[]}
      memberCount={count(members)}
      moduleCount={count(grants)}
    />
  );
}
