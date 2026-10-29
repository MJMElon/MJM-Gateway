"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";

export default function NotFound() {
  const t = useTranslations("errors");
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 px-4 text-center">
      <h1 className="text-lg font-semibold">{t("notFound")}</h1>
      <Link href="/" className="text-sm text-brand-600 hover:underline">
        {t("backHome")}
      </Link>
    </main>
  );
}
