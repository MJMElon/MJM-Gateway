"use client";

import { useTranslations } from "next-intl";
import { AdminTabs } from "@/components/admin/admin-tabs";
import { RequireProfile } from "@/components/guards";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations("admin");
  return (
    <RequireProfile need="admin">
      {(profile) => (
        <div className="space-y-5">
          <div>
            <h1 className="text-xl font-semibold sm:text-2xl">{t("title")}</h1>
            <p className="mt-1 text-sm text-slate-500">{profile.role === "super_admin" ? t("roleSuper") : t("roleAdmin")}</p>
          </div>
          <AdminTabs isSuper={profile.role === "super_admin"} />
          {children}
        </div>
      )}
    </RequireProfile>
  );
}
