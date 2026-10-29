"use client";

import { KeyRound, Pencil, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState, useTransition } from "react";
import { generateApiKey } from "@/lib/api";
import { createClient } from "@/lib/supabase/client";
import type { Department, Module } from "@/lib/types";
import { MODULE_ICONS, ModuleIcon } from "@/components/module-icon";
import { Alert, Badge, Button, Card, cn, EmptyState, Field, Input, Modal, Select } from "@/components/ui";

const emptyModule: Omit<Module, "id"> = {
  code: "",
  name: "",
  icon: "app-window",
  url: "https://",
  description: "",
  category: "",
  access_level: 1,
  is_active: true,
  open_mode: "new_tab",
  department_id: null,
  sort_order: 0,
};

export function ModulesManager({
  modules,
  departments,
  keys,
  functionsUrl,
  onChange,
}: {
  modules: Module[];
  departments: Department[];
  keys: Record<string, string>;
  functionsUrl: string;
  onChange: () => void;
}) {
  const t = useTranslations("admin.modules");
  const supabase = useMemo(() => createClient(), []);
  const [editing, setEditing] = useState<Module | "new" | null>(null);
  const [apiKey, setApiKey] = useState<{ module: Module; key: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const deptName = new Map(departments.map((d) => [d.id, d.name]));

  async function toggleActive(m: Module) {
    const { error } = await supabase.from("gw_modules").update({ is_active: !m.is_active }).eq("id", m.id);
    if (error) setError(t("saveFailed"));
    onChange();
  }

  return (
    <div className="space-y-4">
      {error && <Alert>{error}</Alert>}
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-slate-500">{t("description")}</p>
        <Button onClick={() => setEditing("new")}>
          <Plus className="size-4" /> {t("add")}
        </Button>
      </div>

      {modules.length === 0 ? (
        <EmptyState>{t("empty")}</EmptyState>
      ) : (
        <Card className="divide-y divide-slate-200 dark:divide-slate-800">
          {modules.map((m) => (
            <div key={m.id} className={cn("flex flex-col gap-3 p-4 md:flex-row md:items-center", !m.is_active && "opacity-60")}>
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-700/20 dark:text-brand-100">
                <ModuleIcon name={m.icon} className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{m.name}</span>
                  <span className="font-mono text-xs text-slate-500">{m.code}</span>
                  <Badge tone={m.is_active ? "green" : "slate"}>{m.is_active ? t("active") : t("inactive")}</Badge>
                  <Badge tone="blue">{t(`levels.${m.access_level}`)}</Badge>
                  {m.department_id && <Badge>{deptName.get(m.department_id)}</Badge>}
                </div>
                <p className="mt-0.5 truncate text-sm text-slate-500">{m.url}</p>
                {m.access_level === 2 && (
                  <p className="mt-0.5 text-xs text-slate-400">
                    {keys[m.id] ? t("apiKeySet", { prefix: keys[m.id] }) : t("apiKeyMissing")}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {m.access_level === 2 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() =>
                      startTransition(async () => {
                        const r = await generateApiKey(m.id);
                        if (r.ok) {
                          setApiKey({ module: m, key: r.key });
                          onChange();
                        }
                        else setError(t("saveFailed"));
                      })
                    }
                  >
                    <KeyRound className="size-4" /> {keys[m.id] ? t("rotateKey") : t("generateKey")}
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => setEditing(m)}>
                  <Pencil className="size-4" /> {t("edit")}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => toggleActive(m)}>
                  {m.is_active ? t("deactivate") : t("activate")}
                </Button>
              </div>
            </div>
          ))}
        </Card>
      )}

      {editing && (
        <ModuleDialog
          module={editing === "new" ? null : editing}
          departments={departments}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChange();
          }}
        />
      )}

      {apiKey && (
        <Modal open onClose={() => setApiKey(null)} title={t("apiKeyTitle", { name: apiKey.module.name })} wide>
          <div className="space-y-3 text-sm">
            <p className="text-slate-600 dark:text-slate-300">{t("apiKeyBody")}</p>
            <div className="rounded-lg bg-slate-100 p-3 font-mono break-all select-all dark:bg-slate-800">{apiKey.key}</div>
            <Alert tone="amber">{t("apiKeyWarning")}</Alert>
            <div className="space-y-1 text-xs text-slate-500">
              <p>{t("endpointIssue")}: <code>{functionsUrl}/gw-issue-token</code></p>
              <p>{t("endpointCheck")}: <code>{functionsUrl}/gw-check-access</code></p>
              <p>{t("endpointJwks")}: <code>{functionsUrl}/gw-jwks</code></p>
            </div>
            <div className="flex justify-end">
              <Button onClick={() => setApiKey(null)}>{t("done")}</Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function ModuleDialog({
  module,
  departments,
  onClose,
  onSaved,
}: {
  module: Module | null;
  departments: Department[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("admin.modules");
  const supabase = useMemo(() => createClient(), []);
  const [form, setForm] = useState<Omit<Module, "id">>(() => {
    if (!module) return emptyModule;
    const { id: _id, ...rest } = module;
    return rest;
  });
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      const url = new URL(form.url);
      if (!["https:", "http:"].includes(url.protocol)) throw new Error();
    } catch {
      return setError(t("badUrl"));
    }
    const row = {
      ...form,
      code: form.code.trim().toUpperCase(),
      name: form.name.trim(),
      description: form.description?.trim() || null,
      category: form.category?.trim() || null,
    };
    const { error } = module
      ? await supabase.from("gw_modules").update(row).eq("id", module.id)
      : await supabase.from("gw_modules").insert(row);
    if (error) return setError(error.code === "23505" ? t("duplicate") : error.code === "23514" ? t("badCode") : t("saveFailed"));
    onSaved();
  }

  return (
    <Modal open onClose={onClose} title={module ? t("editTitle") : t("addTitle")} wide>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("code")} hint={t("codeHint")}>
            <Input required value={form.code} onChange={(e) => set("code", e.target.value.toUpperCase())} />
          </Field>
          <Field label={t("name")}>
            <Input required value={form.name} onChange={(e) => set("name", e.target.value)} />
          </Field>
        </div>
        <Field label={t("url")}>
          <Input required type="url" value={form.url} onChange={(e) => set("url", e.target.value)} />
        </Field>
        <Field label={t("descriptionLabel")}>
          <Input value={form.description ?? ""} maxLength={120} onChange={(e) => set("description", e.target.value)} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("category")}>
            <Input value={form.category ?? ""} onChange={(e) => set("category", e.target.value)} />
          </Field>
          <Field label={t("department")} hint={t("departmentHint")}>
            <Select value={form.department_id ?? ""} onChange={(e) => set("department_id", e.target.value || null)}>
              <option value="">{t("noDepartment")}</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("accessLevel")}>
            <Select value={form.access_level} onChange={(e) => set("access_level", Number(e.target.value) as 1 | 2 | 3)}>
              {([1, 2, 3] as const).map((l) => (
                <option key={l} value={l}>
                  {t(`levels.${l}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("openMode")}>
            <Select value={form.open_mode} onChange={(e) => set("open_mode", e.target.value as Module["open_mode"])}>
              <option value="new_tab">{t("newTab")}</option>
              <option value="same_tab">{t("sameTab")}</option>
            </Select>
          </Field>
          <Field label={t("sortOrder")}>
            <Input type="number" value={form.sort_order} onChange={(e) => set("sort_order", Number(e.target.value))} />
          </Field>
          <Field label={t("status")}>
            <Select value={form.is_active ? "1" : "0"} onChange={(e) => set("is_active", e.target.value === "1")}>
              <option value="1">{t("active")}</option>
              <option value="0">{t("inactive")}</option>
            </Select>
          </Field>
        </div>
        <div>
          <p className="mb-1.5 text-sm font-medium text-slate-700 dark:text-slate-300">{t("icon")}</p>
          <div className="flex flex-wrap gap-1.5">
            {Object.keys(MODULE_ICONS).map((key) => (
              <button
                type="button"
                key={key}
                title={key}
                onClick={() => set("icon", key)}
                className={cn(
                  "flex size-9 items-center justify-center rounded-lg border",
                  form.icon === key
                    ? "border-brand-500 bg-brand-50 text-brand-600 dark:bg-brand-700/20 dark:text-brand-100"
                    : "border-slate-200 text-slate-500 dark:border-slate-700",
                )}
              >
                <ModuleIcon name={key} className="size-4" />
              </button>
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button type="submit">{t("save")}</Button>
        </div>
      </form>
    </Modal>
  );
}
