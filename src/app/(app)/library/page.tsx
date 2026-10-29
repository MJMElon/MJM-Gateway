import { getTranslations } from "next-intl/server";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { HomeData } from "@/lib/types";
import { LibraryList } from "@/components/library-list";

export async function generateMetadata() {
  const t = await getTranslations("library");
  return { title: t("title") };
}

export default async function LibraryPage() {
  await requireProfile();
  const supabase = await createClient();
  const t = await getTranslations("library");
  const { data, error } = await supabase.rpc("gw_get_home");
  if (error || !data) throw new Error(error?.message ?? "gw_get_home failed");

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold sm:text-2xl">{t("title")}</h1>
        <p className="mt-1 text-sm text-slate-500">{t("description")}</p>
      </div>
      <LibraryList data={data as HomeData} />
    </div>
  );
}
