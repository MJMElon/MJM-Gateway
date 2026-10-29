import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// 以当前登录用户身份连线：所有查询都经过 RLS
export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // 在 Server Component 中无法写 cookie；proxy 会负责刷新 session
        }
      },
    },
  });
}
