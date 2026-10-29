import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// 记录 Auth 相关事件（登录、改密码、建立用户等）到 gw_audit_logs
export async function logEvent(
  actorId: string | null,
  action: string,
  targetType: string,
  targetId?: string | null,
  targetLabel?: string | null,
  after?: Record<string, unknown>,
) {
  const admin = createAdminClient();
  const { error } = await admin.rpc("gw_log_event", {
    p_actor: actorId,
    p_action: action,
    p_target_type: targetType,
    p_target_id: targetId ?? null,
    p_target_label: targetLabel ?? null,
    p_after: after ?? null,
  });
  if (error) console.error("gw_log_event failed", error.message);
}
