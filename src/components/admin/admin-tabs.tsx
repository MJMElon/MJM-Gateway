"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/components/ui";

export function AdminTabs({ isSuper }: { isSuper: boolean }) {
  const t = useTranslations("admin.tabs");
  const pathname = usePathname();
  const tabs = [
    { href: "/admin/users", label: t("users") },
    { href: "/admin/matrix", label: t("matrix") },
    ...(isSuper
      ? [
          { href: "/admin/groups", label: t("groups") },
          { href: "/admin/modules", label: t("modules") },
          { href: "/admin/departments", label: t("departments") },
        ]
      : []),
    { href: "/admin/announcements", label: t("announcements") },
    { href: "/admin/audit", label: t("audit") },
  ];
  return (
    <div className="-mx-4 overflow-x-auto px-4">
      <nav className="flex min-w-max gap-1 border-b border-slate-200 dark:border-slate-800">
        {tabs.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap",
              pathname.startsWith(tab.href)
                ? "border-brand-600 text-brand-700 dark:text-brand-100"
                : "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200",
            )}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
