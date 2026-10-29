"use client";

import { LogOut } from "lucide-react";
import { useTranslations } from "next-intl";
import { logout } from "@/app/(auth)/actions";

export function UserMenu({ name, email }: { name: string; email: string }) {
  const t = useTranslations("nav");
  return (
    <div className="flex items-center gap-3">
      <div className="hidden text-right leading-tight md:block">
        <div className="text-sm font-medium">{name}</div>
        <div className="text-xs text-slate-500">{email}</div>
      </div>
      <span className="flex size-8 items-center justify-center rounded-full bg-slate-200 text-sm font-semibold dark:bg-slate-800">
        {name.slice(0, 1)}
      </span>
      <form action={logout}>
        <button className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" title={t("logout")} aria-label={t("logout")}>
          <LogOut className="size-4" />
        </button>
      </form>
    </div>
  );
}
