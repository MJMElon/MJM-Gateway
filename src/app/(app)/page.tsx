import { getTranslations } from "next-intl/server";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { HomeData } from "@/lib/types";
import { HomeBoard } from "@/components/home/home-board";

export default async function HomePage() {
  const profile = await requireProfile();
  const supabase = await createClient();
  const t = await getTranslations("home");

  // 第一次登录：按群组自动排好预设版面
  if (!profile.layout_initialized) await supabase.rpc("gw_init_layout");

  const { data, error } = await supabase.rpc("gw_get_home");
  if (error || !data) throw new Error(error?.message ?? "gw_get_home failed");

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold sm:text-2xl">{t("greeting", { name: profile.full_name })}</h1>
      <HomeBoard data={data as HomeData} />
    </div>
  );
}
