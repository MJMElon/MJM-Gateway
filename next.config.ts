import type { NextConfig } from "next";

// 静态网站（GitHub Pages）。所有资料由浏览器直接向 Supabase 读取，权限由数据库 RLS 检查；
// 需要 service_role 的动作在 Supabase Edge Functions（gw-auth、gw-admin）执行。
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

const nextConfig: NextConfig = {
  output: "export",
  basePath,
  trailingSlash: true,
  images: { unoptimized: true },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
