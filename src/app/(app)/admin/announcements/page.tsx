"use client";

import { useAuth } from "@/components/auth-provider";
import { Spinner } from "@/components/guards";
import { AnnouncementsManager, type Announcement } from "@/components/admin/announcements-manager";
import { createClient } from "@/lib/supabase/client";
import type { Department } from "@/lib/types";
import { useLoad } from "@/lib/use-load";

export default function AnnouncementsPage() {
  const { profile } = useAuth();
  const { data, reload } = useLoad(async () => {
    const supabase = createClient();
    const [announcements, departments] = await Promise.all([
      supabase.from("gw_announcements").select("*").order("created_at", { ascending: false }),
      supabase.from("gw_departments").select("id, code, name").order("code"),
    ]);
    return {
      announcements: (announcements.data ?? []) as Announcement[],
      departments: (departments.data ?? []) as Department[],
    };
  });
  if (!data || !profile) return <Spinner />;
  return <AnnouncementsManager me={profile} {...data} onChange={reload} />;
}
