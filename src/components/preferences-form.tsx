"use client";

import { Monitor, Moon, RotateCcw, Sun } from "lucide-react";
import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { resetHome, updatePreferences } from "@/app/(app)/settings/actions";
import { AVAILABLE_LOCALES, LOCALES } from "@/i18n/config";
import { Alert, Button, cn, Field, Modal, Select } from "@/components/ui";

export function PreferencesForm({ locale, theme }: { locale: string; theme: string }) {
  const t = useTranslations("settings");
  const router = useRouter();
  const { setTheme } = useTheme();
  const [pending, startTransition] = useTransition();
  const [currentTheme, setCurrentTheme] = useState(theme);
  const [confirmReset, setConfirmReset] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  // 以资料库里的设定为准（换装置时也一致）
  useEffect(() => setTheme(theme), [theme, setTheme]);

  return (
    <div className="space-y-5">
      {done && <Alert tone="green">{done}</Alert>}
      <Field label={t("language")}>
        <Select
          defaultValue={locale}
          disabled={pending}
          onChange={(e) =>
            startTransition(async () => {
              await updatePreferences({ locale: e.target.value });
              router.refresh();
            })
          }
        >
          {LOCALES.map((l) => (
            <option key={l} value={l} disabled={!AVAILABLE_LOCALES.includes(l)}>
              {t(`locales.${l}`)}
              {!AVAILABLE_LOCALES.includes(l) ? ` (${t("comingSoon")})` : ""}
            </option>
          ))}
        </Select>
      </Field>

      <div>
        <p className="mb-1.5 text-sm font-medium text-slate-700 dark:text-slate-300">{t("theme")}</p>
        <div className="grid grid-cols-3 gap-2">
          {(
            [
              ["light", Sun],
              ["dark", Moon],
              ["system", Monitor],
            ] as const
          ).map(([value, Icon]) => (
            <button
              key={value}
              onClick={() => {
                setCurrentTheme(value);
                setTheme(value);
                startTransition(() => updatePreferences({ theme: value }));
              }}
              className={cn(
                "flex flex-col items-center gap-1 rounded-lg border p-3 text-sm",
                currentTheme === value
                  ? "border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-700/20 dark:text-brand-100"
                  : "border-slate-200 dark:border-slate-700",
              )}
            >
              <Icon className="size-5" />
              {t(`themes.${value}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="border-t border-slate-200 pt-5 dark:border-slate-800">
        <p className="text-sm font-medium">{t("resetHome")}</p>
        <p className="mt-1 mb-3 text-xs text-slate-500">{t("resetHomeDescription")}</p>
        <Button variant="secondary" onClick={() => setConfirmReset(true)}>
          <RotateCcw className="size-4" /> {t("resetHome")}
        </Button>
      </div>

      <Modal open={confirmReset} onClose={() => setConfirmReset(false)} title={t("resetHome")}>
        <p className="mb-5 text-sm text-slate-600 dark:text-slate-300">{t("resetHomeConfirm")}</p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirmReset(false)}>
            {t("cancel")}
          </Button>
          <Button
            variant="danger"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                await resetHome();
                setConfirmReset(false);
                setDone(t("resetHomeDone"));
              })
            }
          >
            {t("confirm")}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
