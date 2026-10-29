"use client";

import { useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import { useAuth } from "@/components/auth-provider";
import { ChangePasswordForm } from "@/components/change-password-form";
import { Spinner } from "@/components/guards";
import { Card } from "@/components/ui";

export default function ChangePasswordPage() {
  return (
    <Suspense>
      <ChangePassword />
    </Suspense>
  );
}

function ChangePassword() {
  const t = useTranslations("password");
  const router = useRouter();
  const reset = useSearchParams().get("reset");
  const { loading, user, profile, refreshProfile } = useAuth();
  const blocked = !loading && (!user || !profile || profile.status !== "active");

  useEffect(() => {
    if (blocked) router.replace(user ? "/login/?error=no_access" : "/login/?error=link_expired");
  }, [blocked, user, router]);

  if (loading || blocked) return <Spinner />;
  return (
    <Card className="p-6">
      <h2 className="text-lg font-semibold">{reset ? t("resetTitle") : t("forcedTitle")}</h2>
      <p className="mt-1 mb-4 text-sm text-slate-500">{reset ? t("resetDescription") : t("forcedDescription")}</p>
      <ChangePasswordForm
        onChanged={async () => {
          await refreshProfile();
          router.replace("/");
        }}
      />
    </Card>
  );
}
