"use client";

import { LayoutGrid } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { AppNav, MobileNav } from "@/components/app-nav";
import { RequireProfile } from "@/components/guards";
import { ThemeSync } from "@/components/theme-sync";
import { UserMenu } from "@/components/user-menu";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations("app");
  return (
    <RequireProfile>
      {(profile) => {
        const isAdmin = profile.role === "super_admin" || profile.role === "admin";
        return (
          <div className="min-h-dvh pb-20 sm:pb-0">
            <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur dark:border-slate-800 dark:bg-slate-950/90">
              <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4">
                <Link href="/" className="flex items-center gap-2 font-semibold">
                  <span className="flex size-8 items-center justify-center rounded-lg bg-brand-600 text-white">
                    <LayoutGrid className="size-4" />
                  </span>
                  <span className="hidden sm:inline">{t("name")}</span>
                </Link>
                <AppNav isAdmin={isAdmin} />
                <div className="ml-auto">
                  <UserMenu name={profile.full_name} email={profile.email} />
                </div>
              </div>
            </header>
            <main className="mx-auto max-w-7xl px-4 py-5 sm:py-8">{children}</main>
            <MobileNav isAdmin={isAdmin} />
            <ThemeSync theme={profile.theme} />
          </div>
        );
      }}
    </RequireProfile>
  );
}
