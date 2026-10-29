"use client";

import { Pencil, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Department, Group } from "@/lib/types";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Modal, Select } from "@/components/ui";

export function GroupsManager({
  groups,
  departments,
  memberCount,
  moduleCount,
}: {
  groups: Group[];
  departments: Department[];
  memberCount: Record<string, number>;
  moduleCount: Record<string, number>;
}) {
  const t = useTranslations("admin.groups");
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const [editing, setEditing] = useState<Group | "new" | null>(null);
  const [deleting, setDeleting] = useState<Group | null>(null);
  const [error, setError] = useState<string | null>(null);
  const deptName = new Map(departments.map((d) => [d.id, d.name]));

  async function remove(group: Group) {
    const { error } = await supabase.from("gw_groups").delete().eq("id", group.id);
    setDeleting(null);
    if (error) setError(t("saveFailed"));
    router.refresh();
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
      {groups.length === 0 ? (
        <EmptyState>{t("empty")}</EmptyState>
      ) : (
        <Card className="divide-y divide-slate-200 dark:divide-slate-800">
          {groups.map((g) => (
            <div key={g.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{g.name}</span>
                  <Badge tone={g.department_id ? "blue" : "slate"}>
                    {g.department_id ? deptName.get(g.department_id) : t("companyWide")}
                  </Badge>
                </div>
                {g.description && <p className="mt-0.5 text-sm text-slate-500">{g.description}</p>}
                <p className="mt-0.5 text-xs text-slate-400">
                  {t("counts", { members: memberCount[g.id] ?? 0, modules: moduleCount[g.id] ?? 0 })}
                </p>
              </div>
              <div className="flex gap-1.5">
                <Button size="sm" variant="ghost" onClick={() => setEditing(g)}>
                  <Pencil className="size-4" /> {t("edit")}
                </Button>
                <Button size="sm" variant="ghost" className="text-red-600 dark:text-red-400" onClick={() => setDeleting(g)}>
                  <Trash2 className="size-4" /> {t("delete")}
                </Button>
              </div>
            </div>
          ))}
        </Card>
      )}

      {editing && (
        <GroupDialog
          group={editing === "new" ? null : editing}
          departments={departments}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      )}

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

function GroupDialog({
  group,
  departments,
  onClose,
  onSaved,
}: {
  group: Group | null;
  departments: Department[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("admin.groups");
  const supabase = useMemo(() => createClient(), []);
  const [name, setName] = useState(group?.name ?? "");
  const [description, setDescription] = useState(group?.description ?? "");
  const [dept, setDept] = useState(group?.department_id ?? "");
  const [sortOrder, setSortOrder] = useState(group?.sort_order ?? 0);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const row = { name: name.trim(), description: description.trim() || null, department_id: dept || null, sort_order: sortOrder };
    const { error } = group
      ? await supabase.from("gw_groups").update(row).eq("id", group.id)
      : await supabase.from("gw_groups").insert(row);
    if (error) return setError(error.code === "23505" ? t("duplicate") : t("saveFailed"));
    onSaved();
  }

  return (
    <Modal open onClose={onClose} title={group ? t("editTitle") : t("addTitle")}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field label={t("name")}>
          <Input required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t("descriptionLabel")}>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label={t("department")} hint={t("departmentHint")}>
          <Select value={dept} onChange={(e) => setDept(e.target.value)}>
            <option value="">{t("companyWide")}</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("sortOrder")}>
          <Input type="number" value={sortOrder} onChange={(e) => setSortOrder(Number(e.target.value))} />
        </Field>
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
