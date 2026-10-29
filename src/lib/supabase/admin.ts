import "server-only";
import { createClient } from "@supabase/supabase-js";

// service_role：会绕过 RLS。只能在确认调用者权限之后，用于 Auth 管理（建立用户、重设密码、停用登录）
export function createAdminClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
