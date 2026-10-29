import { getTranslations } from "next-intl/server";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { Department, Group, Module, Profile } from "@/lib/types";
import { PermissionMatrix } from "@/components/admin/permission-matrix";

export async function generateMetadata() {
  const t = await getTranslations("admin.tabs");
  return { title: t("matrix") };
}

export default async function MatrixPage() {
  const me = await requireAdmin();
  const supabase = await createClient();
  const [{ data: modules }, { data: groups }, { data: users }, { data: grants }, { data: overrides }, { data: members }, { data: departments }] =
    await Promise.all([
      supabase.from("gw_modules").select("*").order("sort_order").order("name"),
      supabase.from("gw_groups").select("*").order("sort_order").order("name"),
      supabase.from("gw_profiles").select("*").eq("status", "active").order("full_name"),
      supabase.from("gw_group_modules").select("group_id, module_id"),
      supabase.from("gw_user_module_overrides").select("user_id, module_id, effect"),
      supabase.from("gw_group_members").select("group_id, user_id"),
      supabase.from("gw_departments").select("id, code, name").order("code"),
    ]);
  const userIds = (users ?? []).map((u) => u.id);
  const { data: effective } = userIds.length
    ? await supabase.rpc("gw_admin_effective", { p_users: userIds })
    : { data: [] };

  return (
    <PermissionMatrix
      me={me}
      modules={(modules ?? []) as Module[]}
      groups={(groups ?? []) as Group[]}
      users={(users ?? []) as Profile[]}
      departments={(departments ?? []) as Department[]}
      grants={grants ?? []}
      overrides={(overrides ?? []) as { user_id: string; module_id: string; effect: "allow" | "deny" }[]}
      members={members ?? []}
      effective={(effective ?? []) as { user_id: string; module_id: string }[]}
    />
  );
}
