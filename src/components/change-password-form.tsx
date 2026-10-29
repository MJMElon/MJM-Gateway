"use client";

import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { Alert, Button, Field, Input } from "@/components/ui";
import { changePassword, type PasswordError } from "@/lib/api";

export function ChangePasswordForm({ onChanged }: { onChanged?: () => void }) {
  const t = useTranslations("password");
  const formRef = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<PasswordError | null>(null);
  const [ok, setOk] = useState(false);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    const result = await changePassword(String(form.get("password") ?? ""), String(form.get("confirm") ?? ""));
    setPending(false);
    setError(result.error ?? null);
    if (result.error) return;
    formRef.current?.reset();
    setOk(true);
    onChanged?.();
  }

  return (
    <form ref={formRef} onSubmit={submit} className="space-y-4">
      {error && <Alert>{t(`errors.${error}`)}</Alert>}
      {ok && !onChanged && <Alert tone="green">{t("changed")}</Alert>}
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
