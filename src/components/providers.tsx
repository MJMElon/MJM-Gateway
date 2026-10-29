"use client";

import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";
import { DEFAULT_LOCALE } from "@/i18n/config";
import zhCN from "../../messages/zh-CN.json";
import { AuthProvider } from "./auth-provider";

// 目前只有简体中文；新增语言时在这里依 profile.locale 载入对应的 messages
export function Providers({ children }: { children: ReactNode }) {
  return (
    <NextIntlClientProvider locale={DEFAULT_LOCALE} messages={zhCN} timeZone="Asia/Kuala_Lumpur">
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
        <AuthProvider>{children}</AuthProvider>
      </ThemeProvider>
    </NextIntlClientProvider>
  );
}
