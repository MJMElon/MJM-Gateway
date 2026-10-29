import type { Metadata, Viewport } from "next";
import { Providers } from "@/components/providers";
import zhCN from "../../messages/zh-CN.json";
import "./globals.css";

export const metadata: Metadata = {
  title: zhCN.app.name,
  description: zhCN.app.tagline,
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f8fafc" },
    { media: "(prefers-color-scheme: dark)", color: "#020617" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN" suppressHydrationWarning className="h-full antialiased">
      <body className="min-h-full">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
