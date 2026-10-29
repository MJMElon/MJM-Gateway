// 支持的语言。新增语言：在 messages/ 加入对应 JSON，并把代码加进 AVAILABLE_LOCALES
export const LOCALES = ["zh-CN", "en", "ms"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "zh-CN";
// 已有翻译文件的语言；其他语言暂时显示简体中文
export const AVAILABLE_LOCALES: Locale[] = ["zh-CN"];
export const LOCALE_COOKIE = "gw_locale";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}
