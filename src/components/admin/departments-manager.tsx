"use client";

import { Pencil, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Department } from "@/lib/types";
import { Alert, Button, Card, EmptyState, Field, Input, Modal } from "@/components/ui";

export function DepartmentsManager({ departments, onChange }: { departments: Department[]; onChange: () => void }) {
  const t = useTranslations("admin.departments");
  const supabase = useMemo(() => createClient(), []);
  const [editing, setEditing] = useState<Department | "new" | null>(null);
  const [deleting, setDeleting] = useState<Department | null>(null);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  function open(d: Department | "new") {
    setEditing(d);
    setCode(d === "new" ? "" : d.code);
    setName(d === "new" ? "" : d.name);
    setError(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const row = { code: code.trim().toUpperCase(), name: name.trim() };
    const { error } =
      editing && editing !== "new"
        ? await supabase.from("gw_departments").update(row).eq("id", editing.id)
        : await supabase.from("gw_departments").insert(row);
    if (error) return setError(error.code === "23505" ? t("duplicate") : error.code === "23514" ? t("badCode") : t("saveFailed"));
    setEditing(null);
    onChange();
  }

  async function remove(d: Department) {
    const { error } = await supabase.from("gw_departments").delete().eq("id", d.id);
    setDeleting(null);
    if (error) setError(t("saveFailed"));
    onChange();
  }

  return (
    <div className="space-y-4">
      {error && !editing && <Alert>{error}</Alert>}
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-slate-500">{t("description")}</p>
        <Button onClick={() => open("new")}>
          <Plus className="size-4" /> {t("add")}
        </Button>
      </div>
      {departments.length === 0 ? (
        <EmptyState>{t("empty")}</EmptyState>
      ) : (
        <Card className="divide-y divide-slate-200 dark:divide-slate-800">
          {departments.map((d) => (
            <div key={d.id} className="flex items-center gap-3 p-4">
              <span className="w-20 shrink-0 font-mono text-sm text-slate-500">{d.code}</span>
              <span className="flex-1 font-medium">{d.name}</span>
              <Button size="sm" variant="ghost" onClick={() => open(d)} aria-label={t("edit")}>
                <Pencil className="size-4" />
              </Button>
              <Button size="sm" variant="ghost" className="text-red-600 dark:text-red-400" onClick={() => setDeleting(d)} aria-label={t("delete")}>
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
        </Card>
      )}

      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing === "new" ? t("addTitle") : t("editTitle")}>
        <form onSubmit={submit} className="space-y-4">
          {error && <Alert>{error}</Alert>}
          <Field label={t("code")} hint={t("codeHint")}>
            <Input required value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={32} />
          </Field>
          <Field label={t("name")}>
            <Input required value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setEditing(null)}>
              {t("cancel")}
            </Button>
            <Button type="submit">{t("save")}</Button>
          </div>
        </form>
      </Modal>

      {deleting && (
        <Modal open onClose={() => setDeleting(null)} title={t("deleteTitle")}>
          <p className="mb-5 text-sm text-slate-600 dark:text-slate-300">{t("deleteBody", { name: deleting.name })}</p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDeleting(null)}>
              {t("cancel")}
            </Button>
            <Button variant="danger" onClick={() => remove(deleting)}>
              {t("delete")}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
