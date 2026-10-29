import { getTranslations } from "next-intl/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { Department } from "@/lib/types";
import { DepartmentsManager } from "@/components/admin/departments-manager";

export async function generateMetadata() {
  const t = await getTranslations("admin.tabs");
  return { title: t("departments") };
}

export default async function DepartmentsPage() {
  await requireSuperAdmin();
  const supabase = await createClient();
  const { data } = await supabase.from("gw_departments").select("id, code, name").order("code");
  return <DepartmentsManager departments={(data ?? []) as Department[]} />;
}
