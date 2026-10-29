import { getTranslations } from "next-intl/server";

const HIDDEN = new Set(["updated_at", "created_at"]);

// 显示改动前后的差异（只列有变化的栏位）
export async function AuditDiff({
  before,
  after,
}: {
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}) {
  const t = await getTranslations("admin.audit");
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].filter(
    (k) => !HIDDEN.has(k) && JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k]),
  );
  if (keys.length === 0) return <p className="mt-2 text-xs text-slate-400">{t("noDetails")}</p>;
  const show = (v: unknown) => (v === undefined ? "—" : JSON.stringify(v));
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="text-xs">
        <thead>
          <tr className="text-left text-slate-500">
            <th className="pr-4 font-medium">{t("field")}</th>
            <th className="pr-4 font-medium">{t("before")}</th>
            <th className="font-medium">{t("after")}</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {keys.map((k) => (
            <tr key={k}>
              <td className="pr-4 text-slate-500">{k}</td>
              <td className="pr-4 text-red-600 dark:text-red-400">{show(before?.[k])}</td>
              <td className="text-emerald-700 dark:text-emerald-400">{show(after?.[k])}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
