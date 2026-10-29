import { cookies } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { AVAILABLE_LOCALES, DEFAULT_LOCALE, isLocale, LOCALE_COOKIE } from "./config";

export default getRequestConfig(async () => {
  const value = (await cookies()).get(LOCALE_COOKIE)?.value;
  const locale = isLocale(value) && AVAILABLE_LOCALES.includes(value) ? value : DEFAULT_LOCALE;
  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
