"use server";

import { createHash, randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { getCurrentProfile } from "@/lib/auth";
import { logEvent } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";

// 产生目标系统调用 gw-check-access 用的 API Key；只显示一次，资料库只存 SHA-256
export async function generateApiKey(moduleId: string) {
  const me = await getCurrentProfile();
  if (!me || me.status !== "active" || me.role !== "super_admin") return { ok: false as const };

  const key = `gwk_${randomBytes(24).toString("base64url")}`;
  const admin = createAdminClient();
  const { error } = await admin.from("gw_module_api_keys").upsert({
    module_id: moduleId,
    key_hash: createHash("sha256").update(key).digest("hex"),
    key_prefix: key.slice(0, 10),
    created_at: new Date().toISOString(),
  });
  if (error) return { ok: false as const };
  await logEvent(me.id, "module.api_key", "modules", moduleId, key.slice(0, 10));
  revalidatePath("/admin/modules");
  return { ok: true as const, key };
}
