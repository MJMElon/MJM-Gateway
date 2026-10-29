"use client";

import { useTranslations } from "next-intl";
import { Spinner } from "@/components/guards";
import { LibraryList } from "@/components/library-list";
import { createClient } from "@/lib/supabase/client";
import type { HomeData } from "@/lib/types";
import { useLoad } from "@/lib/use-load";

export default function LibraryPage() {
  const t = useTranslations("library");
  const { data } = useLoad(async () => {
    const { data, error } = await createClient().rpc("gw_get_home");
    if (error) throw error;
    return data as HomeData;
  });

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold sm:text-2xl">{t("title")}</h1>
        <p className="mt-1 text-sm text-slate-500">{t("description")}</p>
      </div>
      {data ? <LibraryList data={data} /> : <Spinner />}
    </div>
  );
}
