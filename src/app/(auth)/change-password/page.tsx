import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { getCurrentProfile } from "@/lib/auth";
import { ChangePasswordForm } from "@/components/change-password-form";
import { Card } from "@/components/ui";

export default async function ChangePasswordPage({ searchParams }: PageProps<"/change-password">) {
  const profile = await getCurrentProfile();
  if (!profile || profile.status !== "active") redirect("/login?error=no_access");
  const t = await getTranslations("password");
  const { reset } = await searchParams;

  return (
    <Card className="p-6">
      <h2 className="text-lg font-semibold">{reset ? t("resetTitle") : t("forcedTitle")}</h2>
      <p className="mt-1 mb-4 text-sm text-slate-500">{reset ? t("resetDescription") : t("forcedDescription")}</p>
      <ChangePasswordForm redirectTo="/" />
    </Card>
  );
}
