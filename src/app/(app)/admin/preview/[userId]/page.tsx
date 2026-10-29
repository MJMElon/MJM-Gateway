import { Eye } from "lucide-react";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { HomeData } from "@/lib/types";
import { HomeBoard } from "@/components/home/home-board";

// 以此人身份预览首页（只读）。权限检查在 gw_get_home 里：只能预览自己可查看的用户
export default async function PreviewPage({ params }: PageProps<"/admin/preview/[userId]">) {
  await requireAdmin();
  const { userId } = await params;
  const supabase = await createClient();
  const t = await getTranslations("admin.preview");
  const { data, error } = await supabase.rpc("gw_get_home", { p_user: userId });
  if (error || !data) notFound();
  const home = data as HomeData;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 sm:flex-row sm:items-center dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
        <Eye className="size-4 shrink-0" />
        <span className="flex-1">
          {t("banner", { name: home.profile.full_name, email: home.profile.email })}
          {home.profile.department ? ` · ${home.profile.department}` : ""}
        </span>
        <Link href="/admin/users" className="font-medium underline">
          {t("back")}
        </Link>
      </div>
      <HomeBoard data={home} readOnly />
    </div>
  );
}
