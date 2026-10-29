import { getTranslations } from "next-intl/server";
import Link from "next/link";

export default async function NotFound() {
  const t = await getTranslations("errors");
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 px-4 text-center">
      <h1 className="text-lg font-semibold">{t("notFound")}</h1>
      <Link href="/" className="text-sm text-brand-600 hover:underline">
        {t("backHome")}
      </Link>
    </main>
  );
}
