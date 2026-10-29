"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { Alert, Button, Card, Field, Input } from "@/components/ui";
import { login, type LoginResult } from "@/lib/api";

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const t = useTranslations("login");
  const router = useRouter();
  const initialError = useSearchParams().get("error");
  const { loading, user, profile } = useAuth();
  const [state, setState] = useState<LoginResult & { email?: string }>({});
  const [pending, setPending] = useState(false);

  // 已登录：直接进首页
  useEffect(() => {
    if (!loading && user && profile?.status === "active") router.replace(profile.must_change_password ? "/change-password/" : "/");
  }, [loading, user, profile, router]);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get("email") ?? "").trim().toLowerCase();
    setPending(true);
    const result = await login(email, String(form.get("password") ?? ""));
    setPending(false);
    if (result.error) setState({ ...result, email });
  }

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
      <form onSubmit={submit} className="space-y-4">
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
          <Link href="/forgot-password/" className="text-sm text-brand-600 hover:underline dark:text-brand-100">
            {t("forgot")}
          </Link>
        </div>
      </form>
    </Card>
  );
}
