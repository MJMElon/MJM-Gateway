"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef } from "react";
import { changePassword, type PasswordState } from "@/app/(auth)/actions";
import { Alert, Button, Field, Input } from "@/components/ui";

export function ChangePasswordForm({ redirectTo }: { redirectTo?: string }) {
  const t = useTranslations("password");
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState<PasswordState, FormData>(changePassword, {});

  useEffect(() => {
    if (!state.ok) return;
    formRef.current?.reset();
    if (redirectTo) {
      router.replace(redirectTo);
      router.refresh();
    }
  }, [state, redirectTo, router]);

  return (
    <form ref={formRef} action={action} className="space-y-4">
      {state.error && <Alert>{t(`errors.${state.error}`)}</Alert>}
      {state.ok && !redirectTo && <Alert tone="green">{t("changed")}</Alert>}
      <Field label={t("new")} hint={t("rule")}>
        <Input name="password" type="password" autoComplete="new-password" required minLength={8} />
      </Field>
      <Field label={t("confirm")}>
        <Input name="confirm" type="password" autoComplete="new-password" required minLength={8} />
      </Field>
      <Button type="submit" disabled={pending} className="w-full sm:w-auto">
        {t("submit")}
      </Button>
    </form>
  );
}
