"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { Alert, Button, Card, Field, Input } from "@/components/ui";
import { forgotPassword, type ForgotState } from "../actions";

export default function ForgotPasswordPage() {
  const t = useTranslations("forgot");
  const [state, action, pending] = useActionState<ForgotState, FormData>(forgotPassword, {});

  return (
    <Card className="p-6">
      <form action={action} className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">{t("title")}</h2>
          <p className="mt-1 text-sm text-slate-500">{t("description")}</p>
        </div>
        {state.sent && <Alert tone="green">{t("sent")}</Alert>}
        <Field label={t("email")}>
          <Input name="email" type="email" required inputMode="email" />
        </Field>
        <Button type="submit" className="w-full" disabled={pending}>
          {t("submit")}
        </Button>
        <div className="text-center">
          <Link href="/login" className="text-sm text-brand-600 hover:underline dark:text-brand-100">
            {t("back")}
          </Link>
        </div>
      </form>
    </Card>
  );
}
