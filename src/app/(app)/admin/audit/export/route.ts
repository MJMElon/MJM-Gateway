import ExcelJS from "exceljs";
import { getTranslations } from "next-intl/server";
import type { NextRequest } from "next/server";
import { getCurrentProfile } from "@/lib/auth";
import { auditQuery, readAuditFilters, type AuditRow } from "@/lib/audit-query";
import { createClient } from "@/lib/supabase/server";

const MAX_ROWS = 10000;

// 导出 Excel（同样以调用者身份查询，RLS 决定范围）
export async function GET(request: NextRequest) {
  const me = await getCurrentProfile();
  if (!me || me.status !== "active" || (me.role !== "super_admin" && me.role !== "admin")) {
    return new Response("forbidden", { status: 403 });
  }
  const filters = readAuditFilters(Object.fromEntries(request.nextUrl.searchParams));
  const supabase = await createClient();
  const t = await getTranslations("admin.audit");

  const rows: AuditRow[] = [];
  for (let offset = 0; offset < MAX_ROWS; offset += 1000) {
    const { data } = await auditQuery(supabase, filters).range(offset, offset + 999);
    rows.push(...((data ?? []) as AuditRow[]));
    if (!data || data.length < 1000) break;
  }

  const workbook = new ExcelJS.Workbook();
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

  const buffer = await workbook.xlsx.writeBuffer();
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(buffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="gateway-audit-${stamp}.xlsx"`,
    },
  });
}
