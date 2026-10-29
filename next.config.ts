import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  // 所有页面都依登录状态动态产生，使用传统缓存模式（不开 Cache Components）
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  experimental: {
    // Excel 批量导入
    serverActions: { bodySizeLimit: "5mb" },
  },
};

export default withNextIntl(nextConfig);
