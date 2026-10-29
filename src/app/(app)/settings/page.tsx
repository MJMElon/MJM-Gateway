import { getTranslations } from "next-intl/server";
import { requireProfile } from "@/lib/auth";
import { ChangePasswordForm } from "@/components/change-password-form";
import { PreferencesForm } from "@/components/preferences-form";
import { Card } from "@/components/ui";

export async function generateMetadata() {
  const t = await getTranslations("settings");
  return { title: t("title") };
}

export default async function SettingsPage() {
  const profile = await requireProfile();
  const t = await getTranslations("settings");
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <h1 className="text-xl font-semibold sm:text-2xl">{t("title")}</h1>
      <Card className="p-5">
        <h2 className="mb-4 font-semibold">{t("preferences")}</h2>
        <PreferencesForm locale={profile.locale} theme={profile.theme} />
      </Card>
      <Card className="p-5">
        <h2 className="mb-4 font-semibold">{t("changePassword")}</h2>
        <ChangePasswordForm />
      </Card>
    </div>
  );
}
