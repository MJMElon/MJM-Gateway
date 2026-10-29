"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { AVAILABLE_LOCALES, isLocale, LOCALE_COOKIE } from "@/i18n/config";
import { createClient } from "@/lib/supabase/server";

export async function updatePreferences(input: { locale?: string; theme?: string }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("unauthorized");

  const patch: Record<string, string> = {};
  if (input.locale && isLocale(input.locale)) patch.locale = input.locale;
  if (input.theme && ["light", "dark", "system"].includes(input.theme)) patch.theme = input.theme;
  const { error } = await supabase.from("gw_profiles").update(patch).eq("id", user.id);
  if (error) throw new Error(error.message);

  if (patch.locale && AVAILABLE_LOCALES.includes(patch.locale as never)) {
    (await cookies()).set(LOCALE_COOKIE, patch.locale, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
  }
  revalidatePath("/", "layout");
}

export async function resetHome() {
  const supabase = await createClient();
  const { error } = await supabase.rpc("gw_reset_layout");
  if (error) throw new Error(error.message);
  revalidatePath("/");
}
