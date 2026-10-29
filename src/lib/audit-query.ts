import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export type AuditFilters = { from?: string; to?: string; action?: string; actor?: string; target?: string };

export function readAuditFilters(params: Record<string, string | string[] | undefined>): AuditFilters {
  const get = (k: string) => (typeof params[k] === "string" && params[k] ? (params[k] as string) : undefined);
  return { from: get("from"), to: get("to"), action: get("action"), actor: get("actor"), target: get("target") };
}

// 依筛选条件查询操作记录（以调用者身份，RLS 决定看得到哪些）
export function auditQuery(supabase: SupabaseClient, f: AuditFilters) {
  let q = supabase.from("gw_audit_logs").select("*", { count: "exact" }).order("created_at", { ascending: false });
  if (f.from) q = q.gte("created_at", new Date(`${f.from}T00:00:00`).toISOString());
  if (f.to) q = q.lt("created_at", new Date(new Date(`${f.to}T00:00:00`).getTime() + 86400000).toISOString());
  if (f.action) q = q.ilike("action", `${f.action}%`);
  if (f.actor) q = q.ilike("actor_email", `%${f.actor}%`);
  if (f.target) q = q.eq("target_type", f.target);
  return q;
}

export type AuditRow = {
  id: number;
  created_at: string;
  actor_email: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  target_label: string | null;
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown> | null;
};
