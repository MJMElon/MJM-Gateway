import { getTranslations } from "next-intl/server";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { Department } from "@/lib/types";
import { AnnouncementsManager, type Announcement } from "@/components/admin/announcements-manager";

export async function generateMetadata() {
  const t = await getTranslations("admin.tabs");
  return { title: t("announcements") };
}

export default async function AnnouncementsPage() {
  const me = await requireAdmin();
  const supabase = await createClient();
  const [{ data: announcements }, { data: departments }] = await Promise.all([
    supabase.from("gw_announcements").select("*").order("created_at", { ascending: false }),
    supabase.from("gw_departments").select("id, code, name").order("code"),
  ]);
  return (
    <AnnouncementsManager
      me={me}
      announcements={(announcements ?? []) as Announcement[]}
      departments={(departments ?? []) as Department[]}
    />
  );
}
