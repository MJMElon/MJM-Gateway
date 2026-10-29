"use client";

import { useTranslations } from "next-intl";
import { useAuth } from "@/components/auth-provider";
import { Spinner } from "@/components/guards";
import { HomeBoard } from "@/components/home/home-board";
import { createClient } from "@/lib/supabase/client";
import type { HomeData } from "@/lib/types";
import { useLoad } from "@/lib/use-load";

export default function HomePage() {
  const t = useTranslations("home");
  const { profile } = useAuth();
  const { data } = useLoad(async () => {
    const supabase = createClient();
    // 第一次登录：按群组自动排好预设版面
    if (!profile?.layout_initialized) await supabase.rpc("gw_init_layout");
    const { data, error } = await supabase.rpc("gw_get_home");
    if (error) throw error;
    return data as HomeData;
  });

  if (!data) return <Spinner />;
  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold sm:text-2xl">{t("greeting", { name: data.profile.full_name })}</h1>
      <HomeBoard data={data} />
    </div>
  );
}
