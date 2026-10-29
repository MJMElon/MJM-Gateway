// 文件夹颜色（资料库存 key）
export const FOLDER_COLORS: Record<string, { dot: string; bar: string }> = {
  slate: { dot: "bg-slate-400", bar: "border-l-slate-400" },
  blue: { dot: "bg-blue-500", bar: "border-l-blue-500" },
  green: { dot: "bg-emerald-500", bar: "border-l-emerald-500" },
  amber: { dot: "bg-amber-500", bar: "border-l-amber-500" },
  purple: { dot: "bg-violet-500", bar: "border-l-violet-500" },
  rose: { dot: "bg-rose-500", bar: "border-l-rose-500" },
  teal: { dot: "bg-teal-500", bar: "border-l-teal-500" },
};
export const FOLDER_COLOR_KEYS = Object.keys(FOLDER_COLORS);

export function folderColor(key: string) {
  return FOLDER_COLORS[key] ?? FOLDER_COLORS.slate;
}
