"use client";

import { Check, Plus, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { HomeData } from "@/lib/types";
import { ModuleIcon } from "@/components/module-icon";
import { Badge, Button, Card, EmptyState, Input, Select } from "@/components/ui";

const ROOT = "root";

export function LibraryList({ data }: { data: HomeData }) {
  const t = useTranslations("library");
  const supabase = useMemo(() => createClient(), []);
  const [onHome, setOnHome] = useState(() => new Set(data.layout.map((l) => l.module_id)));
  const [target, setTarget] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  // 打开模块库 = 已看过新模块；本次画面仍显示 NEW，下次就不显示
  useEffect(() => {
    const ids = data.modules.filter((m) => m.is_new).map((m) => m.id);
    if (ids.length) supabase.rpc("gw_mark_seen", { p_modules: ids });
  }, [data.modules, supabase]);

  const q = query.trim().toLowerCase();
  const filtered = data.modules.filter(
    (m) => !q || [m.name, m.code, m.description, m.category].some((v) => v?.toLowerCase().includes(q)),
  );
  const groups = new Map<string, typeof filtered>();
  filtered.forEach((m) => {
    const key = m.category || t("otherCategory");
    groups.set(key, [...(groups.get(key) ?? []), m]);
  });

  async function add(moduleId: string) {
    const folder = target[moduleId] ?? ROOT;
    const folderId = folder === ROOT ? null : folder;
    const sortOrder = Math.max(0, ...data.layout.filter((l) => l.folder_id === folderId).map((l) => l.sort_order)) + onHome.size + 1;
    setBusy(moduleId);
    const { error } = await supabase.rpc("gw_save_layout", {
      p_items: [{ module_id: moduleId, folder_id: folderId, sort_order: sortOrder, card_size: "large" }],
    });
    setBusy(null);
    if (!error) setOnHome((s) => new Set(s).add(moduleId));
  }

  return (
    <div className="space-y-5">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
        <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("searchPlaceholder")} className="pl-9" />
      </div>

      {data.modules.length === 0 && <EmptyState>{t("empty")}</EmptyState>}

      {[...groups.entries()].map(([category, modules]) => (
        <section key={category}>
          <h2 className="mb-2 text-sm font-medium text-slate-500">{category}</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {modules.map((m) => {
              const added = onHome.has(m.id);
              return (
                <Card key={m.id} className="flex flex-col gap-3 p-4">
                  <div className="flex items-start gap-3">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-700/20 dark:text-brand-100">
                      <ModuleIcon name={m.icon} className="size-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate font-medium">{m.name}</span>
                        {m.is_new && <Badge tone="red">{t("new")}</Badge>}
                      </div>
                      {m.description && <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">{m.description}</p>}
                    </div>
                  </div>
                  {added ? (
                    <div className="flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
                      <Check className="size-4" /> {t("onHome")}
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      {data.folders.length > 0 && (
                        <Select
                          value={target[m.id] ?? ROOT}
                          onChange={(e) => setTarget((s) => ({ ...s, [m.id]: e.target.value }))}
                          className="h-8 flex-1 text-xs"
                          aria-label={t("folder")}
                        >
                          <option value={ROOT}>{t("uncategorized")}</option>
                          {data.folders.map((f) => (
                            <option key={f.id} value={f.id}>
                              {f.name}
                            </option>
                          ))}
                        </Select>
                      )}
                      <Button size="sm" onClick={() => add(m.id)} disabled={busy === m.id}>
                        <Plus className="size-4" /> {t("add")}
                      </Button>
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
