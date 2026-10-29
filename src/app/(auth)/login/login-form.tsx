"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { Alert, Button, Card, Field, Input } from "@/components/ui";
import { login, type LoginState } from "../actions";

export function LoginForm({ initialError }: { initialError?: string }) {
  const t = useTranslations("login");
  const [state, action, pending] = useActionState<LoginState, FormData>(login, {});

  const message = (() => {
    switch (state.error) {
      case "invalid":
        return state.remaining !== undefined ? t("errors.invalidRemaining", { remaining: state.remaining }) : t("errors.invalid");
      case "locked":
        return t("errors.locked", { minutes: state.minutes ?? 15 });
      case "disabled":
        return t("errors.disabled");
      case "no_access":
        return t("errors.noAccess");
      case "unknown":
        return t("errors.unknown");
    }
    if (initialError === "no_access") return t("errors.noAccess");
    if (initialError === "link_expired") return t("errors.linkExpired");
    return null;
  })();

  return (
    <Card className="p-6">
      <form action={action} className="space-y-4">
        <h2 className="text-lg font-semibold">{t("title")}</h2>
        {message && <Alert>{message}</Alert>}
        <Field label={t("email")}>
          <Input name="email" type="email" autoComplete="username" required defaultValue={state.email} inputMode="email" />
        </Field>
        <Field label={t("password")}>
          <Input name="password" type="password" autoComplete="current-password" required />
        </Field>
        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? t("submitting") : t("submit")}
        </Button>
        <div className="text-center">
          <Link href="/forgot-password" className="text-sm text-brand-600 hover:underline dark:text-brand-100">
            {t("forgot")}
          </Link>
        </div>
      </form>
    </Card>
  );
}
