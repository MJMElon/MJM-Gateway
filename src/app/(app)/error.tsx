"use client";

import { useTranslations } from "next-intl";
import { Button, Card } from "@/components/ui";

export default function AppError({ reset }: { error: Error; reset: () => void }) {
  const t = useTranslations("errors");
  return (
    <Card className="mx-auto max-w-md p-6 text-center">
      <h2 className="text-lg font-semibold">{t("title")}</h2>
      <p className="mt-1 mb-4 text-sm text-slate-500">{t("description")}</p>
      <Button onClick={reset}>{t("retry")}</Button>
    </Card>
  );
}
