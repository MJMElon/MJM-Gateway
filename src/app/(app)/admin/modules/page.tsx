import { getTranslations } from "next-intl/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { Department, Module } from "@/lib/types";
import { ModulesManager } from "@/components/admin/modules-manager";

export async function generateMetadata() {
  const t = await getTranslations("admin.tabs");
  return { title: t("modules") };
}

export default async function ModulesPage() {
  await requireSuperAdmin();
  const supabase = await createClient();
  const [{ data: modules }, { data: departments }, { data: keys }] = await Promise.all([
    supabase.from("gw_modules").select("*").order("sort_order").order("name"),
    supabase.from("gw_departments").select("id, code, name").order("code"),
    // API Key 表只有 service_role 能读；只取前缀（已确认是 super_admin）
    createAdminClient().from("gw_module_api_keys").select("module_id, key_prefix, created_at"),
  ]);
  return (
    <ModulesManager
      modules={(modules ?? []) as Module[]}
      departments={(departments ?? []) as Department[]}
      keys={Object.fromEntries((keys ?? []).map((k) => [k.module_id, k.key_prefix]))}
      functionsUrl={`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1`}
    />
  );
}
