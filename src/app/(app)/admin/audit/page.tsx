"use client";

import { Download } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { AuditDiff } from "@/components/admin/audit-diff";
import { Spinner } from "@/components/guards";
import { Badge, Button, Card, EmptyState, Input, Select } from "@/components/ui";
import { downloadXlsx } from "@/lib/api";
import { createClient } from "@/lib/supabase/client";
import { useLoad } from "@/lib/use-load";

const PAGE_SIZE = 50;
const MAX_EXPORT = 10000;
const TARGETS = ["auth", "profiles", "groups", "group_members", "modules", "group_modules", "user_module_overrides", "departments", "announcements"] as const;
type Target = (typeof TARGETS)[number];
const isTarget = (x: string): x is Target => (TARGETS as readonly string[]).includes(x);

type Filters = { from: string; to: string; action: string; actor: string; target: string };
type AuditRow = {
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

// 依筛选条件查询操作记录（以当前用户身份，RLS 决定看得到哪些）
function auditQuery(f: Filters) {
  let q = createClient().from("gw_audit_logs").select("*", { count: "exact" }).order("created_at", { ascending: false });
  if (f.from) q = q.gte("created_at", new Date(`${f.from}T00:00:00`).toISOString());
  if (f.to) q = q.lt("created_at", new Date(new Date(`${f.to}T00:00:00`).getTime() + 86400000).toISOString());
  if (f.action) q = q.ilike("action", `${f.action}%`);
  if (f.actor) q = q.ilike("actor_email", `%${f.actor}%`);
  if (f.target) q = q.eq("target_type", f.target);
  return q;
}

const EMPTY: Filters = { from: "", to: "", action: "", actor: "", target: "" };

export default function AuditPage() {
  const t = useTranslations("admin.audit");
  const format = useFormatter();
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);

  const { data } = useLoad(async () => {
    const { data, count } = await auditQuery(filters).range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
    return { rows: (data ?? []) as AuditRow[], count: count ?? 0 };
  }, [filters, page]);

  const pages = Math.max(1, Math.ceil((data?.count ?? 0) / PAGE_SIZE));

  async function exportExcel() {
    setExporting(true);
    const rows: AuditRow[] = [];
    for (let offset = 0; offset < MAX_EXPORT; offset += 1000) {
      const { data } = await auditQuery(filters).range(offset, offset + 999);
      rows.push(...((data ?? []) as AuditRow[]));
      if (!data || data.length < 1000) break;
    }
    await downloadXlsx(`gateway-audit-${new Date().toISOString().slice(0, 10)}.xlsx`, (workbook) => {
      const sheet = workbook.addWorksheet("audit");
      sheet.columns = [
        { header: t("time"), key: "time", width: 22 },
        { header: t("actor"), key: "actor", width: 28 },
        { header: t("action"), key: "action", width: 24 },
        { header: t("target"), key: "target", width: 22 },
        { header: t("targetLabel"), key: "label", width: 28 },
        { header: t("before"), key: "before", width: 50 },
        { header: t("after"), key: "after", width: 50 },
      ];
      sheet.getRow(1).font = { bold: true };
      rows.forEach((r) =>
        sheet.addRow({
          time: new Date(r.created_at),
          actor: r.actor_email ?? t("system"),
          action: r.action,
          target: r.target_type,
          label: r.target_label ?? r.target_id ?? "",
          before: r.before_data ? JSON.stringify(r.before_data) : "",
          after: r.after_data ? JSON.stringify(r.after_data) : "",
        }),
      );
      sheet.getColumn("time").numFmt = "yyyy-mm-dd hh:mm:ss";
    });
    setExporting(false);
  }

  return (
    <div className="space-y-4">
      <form
        className="grid grid-cols-2 gap-2 lg:grid-cols-[repeat(5,minmax(0,1fr))_auto_auto]"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          setFilters(Object.fromEntries(Object.keys(EMPTY).map((k) => [k, String(f.get(k) ?? "").trim()])) as Filters);
          setPage(1);
        }}
      >
        <Input type="date" name="from" aria-label={t("from")} title={t("from")} />
        <Input type="date" name="to" aria-label={t("to")} title={t("to")} />
        <Input name="actor" placeholder={t("actor")} />
        <Input name="action" placeholder={t("action")} />
        <Select name="target" defaultValue="" className="col-span-2 lg:col-span-1">
          <option value="">{t("allTargets")}</option>
          {TARGETS.map((x) => (
            <option key={x} value={x}>
              {t(`targets.${x}`)}
            </option>
          ))}
        </Select>
        <Button type="submit">{t("filter")}</Button>
        <Button type="button" variant="secondary" onClick={exportExcel} disabled={exporting}>
          <Download className="size-4" /> {t("export")}
        </Button>
      </form>

      {!data ? (
        <Spinner />
      ) : (
        <>
          <p className="text-sm text-slate-500">{t("total", { count: data.count })}</p>
          {data.rows.length === 0 ? (
            <EmptyState>{t("empty")}</EmptyState>
          ) : (
            <Card className="divide-y divide-slate-200 dark:divide-slate-800">
              {data.rows.map((r) => (
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
                <Button variant="secondary" size="sm" onClick={() => setPage(page - 1)}>
                  {t("prev")}
                </Button>
              )}
              <span className="text-slate-500">{t("page", { page, pages })}</span>
              {page < pages && (
                <Button variant="secondary" size="sm" onClick={() => setPage(page + 1)}>
                  {t("next")}
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
