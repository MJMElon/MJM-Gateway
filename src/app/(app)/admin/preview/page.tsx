"use client";

import { Eye } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Spinner } from "@/components/guards";
import { HomeBoard } from "@/components/home/home-board";
import { EmptyState } from "@/components/ui";
import { createClient } from "@/lib/supabase/client";
import type { HomeData } from "@/lib/types";
import { useLoad } from "@/lib/use-load";

export default function PreviewPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Preview />
    </Suspense>
  );
}

// 以此人身份预览首页（只读）。权限检查在 gw_get_home 里：只能预览自己可查看的用户
function Preview() {
  const t = useTranslations("admin.preview");
  const userId = useSearchParams().get("user");
  const { data, error } = useLoad(async () => {
    const { data, error } = await createClient().rpc("gw_get_home", { p_user: userId });
    if (error) throw error;
    return data as HomeData;
  }, [userId]);

  if (error) return <EmptyState>{t("notAllowed")}</EmptyState>;
  if (!data) return <Spinner />;
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 sm:flex-row sm:items-center dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
        <Eye className="size-4 shrink-0" />
        <span className="flex-1">
          {t("banner", { name: data.profile.full_name, email: data.profile.email })}
          {data.profile.department ? ` · ${data.profile.department}` : ""}
        </span>
        <Link href="/admin/users/" className="font-medium underline">
          {t("back")}
        </Link>
      </div>
      <HomeBoard key={userId} data={data} readOnly />
    </div>
  );
}
