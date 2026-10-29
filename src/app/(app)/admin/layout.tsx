import { getTranslations } from "next-intl/server";
import { requireAdmin } from "@/lib/auth";
import { AdminTabs } from "@/components/admin/admin-tabs";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const profile = await requireAdmin();
  const t = await getTranslations("admin");
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold sm:text-2xl">{t("title")}</h1>
        <p className="mt-1 text-sm text-slate-500">{profile.role === "super_admin" ? t("roleSuper") : t("roleAdmin")}</p>
      </div>
      <AdminTabs isSuper={profile.role === "super_admin"} />
      {children}
    </div>
  );
}
