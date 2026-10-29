import { getFormatter, getTranslations } from "next-intl/server";
import Link from "next/link";
import { Download } from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { auditQuery, readAuditFilters, type AuditRow } from "@/lib/audit-query";
import { createClient } from "@/lib/supabase/server";
import { AuditDiff } from "@/components/admin/audit-diff";
import { Badge, Button, Card, EmptyState, Input, Select } from "@/components/ui";

const PAGE_SIZE = 50;
const TARGETS = ["auth", "profiles", "groups", "group_members", "modules", "group_modules", "user_module_overrides", "departments", "announcements"] as const;
type Target = (typeof TARGETS)[number];
const isTarget = (x: string): x is Target => (TARGETS as readonly string[]).includes(x);

export async function generateMetadata() {
  const t = await getTranslations("admin.tabs");
  return { title: t("audit") };
}

export default async function AuditPage({ searchParams }: PageProps<"/admin/audit">) {
  await requireAdmin();
  const params = await searchParams;
  const filters = readAuditFilters(params);
  const page = Math.max(1, Number(params.page) || 1);
  const supabase = await createClient();
  const t = await getTranslations("admin.audit");
  const format = await getFormatter();

  const { data, count } = await auditQuery(supabase, filters).range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  const rows = (data ?? []) as AuditRow[];
  const pages = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));
  const qs = (extra: Record<string, string | number>) =>
    new URLSearchParams(
      Object.entries({ ...filters, ...extra }).filter(([, v]) => v !== undefined && v !== "") as [string, string][],
    ).toString();

  return (
    <div className="space-y-4">
      <form className="grid grid-cols-2 gap-2 lg:grid-cols-[repeat(5,minmax(0,1fr))_auto_auto]">
        <Input type="date" name="from" defaultValue={filters.from} aria-label={t("from")} title={t("from")} />
        <Input type="date" name="to" defaultValue={filters.to} aria-label={t("to")} title={t("to")} />
        <Input name="actor" defaultValue={filters.actor} placeholder={t("actor")} />
        <Input name="action" defaultValue={filters.action} placeholder={t("action")} />
        <Select name="target" defaultValue={filters.target ?? ""} className="col-span-2 lg:col-span-1">
          <option value="">{t("allTargets")}</option>
          {TARGETS.map((x) => (
            <option key={x} value={x}>
              {t(`targets.${x}`)}
            </option>
          ))}
        </Select>
        <Button type="submit">{t("filter")}</Button>
        <a href={`/admin/audit/export?${qs({})}`}>
          <Button type="button" variant="secondary" className="w-full">
            <Download className="size-4" /> {t("export")}
          </Button>
        </a>
      </form>

      <p className="text-sm text-slate-500">{t("total", { count: count ?? 0 })}</p>

      {rows.length === 0 ? (
        <EmptyState>{t("empty")}</EmptyState>
      ) : (
        <Card className="divide-y divide-slate-200 dark:divide-slate-800">
          {rows.map((r) => (
            <details key={r.id} className="group p-3 text-sm">
              <summary className="flex cursor-pointer list-none flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
                <span className="w-40 shrink-0 text-xs text-slate-500 tabular-nums">
                  {format.dateTime(new Date(r.created_at), { dateStyle: "short", timeStyle: "medium" })}
                </span>
                <span className="w-48 shrink-0 truncate">{r.actor_email ?? t("system")}</span>
                <span className="flex flex-1 flex-wrap items-center gap-1.5">
                  <Badge tone="blue">{r.action}</Badge>
                  <Badge>{isTarget(r.target_type) ? t(`targets.${r.target_type}`) : r.target_type}</Badge>
                  <span className="truncate text-slate-600 dark:text-slate-300">{r.target_label}</span>
                </span>
              </summary>
              <AuditDiff before={r.before_data} after={r.after_data} />
            </details>
          ))}
        </Card>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-center gap-2 text-sm">
          {page > 1 && (
            <Link href={`/admin/audit?${qs({ page: page - 1 })}`}>
              <Button variant="secondary" size="sm">{t("prev")}</Button>
            </Link>
          )}
          <span className="text-slate-500">{t("page", { page, pages })}</span>
          {page < pages && (
            <Link href={`/admin/audit?${qs({ page: page + 1 })}`}>
              <Button variant="secondary" size="sm">{t("next")}</Button>
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
