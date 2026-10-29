"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";
import { Alert, Button, Card, Field, Input } from "@/components/ui";
import { absoluteUrl } from "@/lib/paths";
import { createClient } from "@/lib/supabase/client";

export default function ForgotPasswordPage() {
  const t = useTranslations("forgot");
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get("email") ?? "").trim().toLowerCase();
    setPending(true);
    if (email) {
      await createClient().auth.resetPasswordForEmail(email, { redirectTo: absoluteUrl("/change-password/?reset=1") });
    }
    setPending(false);
    // 不论 email 是否存在都显示相同结果，避免泄漏帐号
    setSent(true);
  }

  return (
    <Card className="p-6">
      <form onSubmit={submit} className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">{t("title")}</h2>
          <p className="mt-1 text-sm text-slate-500">{t("description")}</p>
        </div>
        {sent && <Alert tone="green">{t("sent")}</Alert>}
        <Field label={t("email")}>
          <Input name="email" type="email" required inputMode="email" />
        </Field>
        <Button type="submit" className="w-full" disabled={pending}>
          {t("submit")}
        </Button>
        <div className="text-center">
          <Link href="/login/" className="text-sm text-brand-600 hover:underline dark:text-brand-100">
            {t("back")}
          </Link>
        </div>
      </form>
    </Card>
  );
}
