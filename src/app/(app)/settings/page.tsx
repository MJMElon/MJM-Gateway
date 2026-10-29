"use client";

import { useTranslations } from "next-intl";
import { useAuth } from "@/components/auth-provider";
import { ChangePasswordForm } from "@/components/change-password-form";
import { PreferencesForm } from "@/components/preferences-form";
import { Card } from "@/components/ui";

export default function SettingsPage() {
  const t = useTranslations("settings");
  const { profile } = useAuth();
  if (!profile) return null;
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <h1 className="text-xl font-semibold sm:text-2xl">{t("title")}</h1>
      <Card className="p-5">
        <h2 className="mb-4 font-semibold">{t("preferences")}</h2>
        <PreferencesForm profileId={profile.id} locale={profile.locale} theme={profile.theme} />
      </Card>
      <Card className="p-5">
        <h2 className="mb-4 font-semibold">{t("changePassword")}</h2>
        <ChangePasswordForm />
      </Card>
    </div>
  );
}
