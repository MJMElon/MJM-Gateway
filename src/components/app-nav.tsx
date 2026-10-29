"use client";

import { House, Library, Settings, ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/components/ui";

function useItems(isAdmin: boolean) {
  const t = useTranslations("nav");
  return [
    { href: "/", label: t("home"), icon: House },
    { href: "/library", label: t("library"), icon: Library },
    ...(isAdmin ? [{ href: "/admin", label: t("admin"), icon: ShieldCheck }] : []),
    { href: "/settings", label: t("settings"), icon: Settings },
  ];
}

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

export function AppNav({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  const items = useItems(isAdmin);
  return (
    <nav className="hidden items-center gap-1 sm:flex">
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={cn(
            "rounded-lg px-3 py-1.5 text-sm font-medium",
            isActive(pathname, item.href)
              ? "bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-white"
              : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white",
          )}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

// 手机底部导航
export function MobileNav({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  const items = useItems(isAdmin);
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur sm:hidden dark:border-slate-800 dark:bg-slate-950/95">
      <div className="flex">
        {items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px]",
              isActive(pathname, item.href) ? "text-brand-600 dark:text-brand-100" : "text-slate-500",
            )}
          >
            <item.icon className="size-5" />
            {item.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
