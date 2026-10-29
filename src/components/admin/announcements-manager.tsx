"use client";

import { Plus, Trash2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Department, Profile } from "@/lib/types";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Modal, Select } from "@/components/ui";

export type Announcement = {
  id: string;
  message: string;
  level: "info" | "warning";
  department_id: string | null;
  is_active: boolean;
  starts_at: string;
  ends_at: string | null;
  created_at: string;
};

// datetime-local 与 ISO 互转（使用浏览器时区）
const toLocalInput = (iso: string) => {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

export function AnnouncementsManager({
  me,
  announcements,
  departments,
}: {
  me: Profile;
  announcements: Announcement[];
  departments: Department[];
}) {
  const t = useTranslations("admin.announcements");
  const format = useFormatter();
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const isSuper = me.role === "super_admin";
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [level, setLevel] = useState<"info" | "warning">("info");
  const [dept, setDept] = useState(isSuper ? "" : me.department_id ?? "");
  const [startsAt, setStartsAt] = useState(() => toLocalInput(new Date().toISOString()));
  const [endsAt, setEndsAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  const deptName = new Map(departments.map((d) => [d.id, d.name]));

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const { error } = await supabase.from("gw_announcements").insert({
      message: message.trim(),
      level,
      department_id: dept || null,
      starts_at: new Date(startsAt).toISOString(),
      ends_at: endsAt ? new Date(endsAt).toISOString() : null,
      created_by: me.id,
    });
    if (error) return setError(t("saveFailed"));
    setOpen(false);
    setMessage("");
    router.refresh();
  }

  async function toggle(a: Announcement) {
    await supabase.from("gw_announcements").update({ is_active: !a.is_active }).eq("id", a.id);
    router.refresh();
  }

  async function remove(a: Announcement) {
    await supabase.from("gw_announcements").delete().eq("id", a.id);
    router.refresh();
  }

  const status = (a: Announcement) => {
    if (!a.is_active) return <Badge>{t("off")}</Badge>;
    if (new Date(a.starts_at).getTime() > now) return <Badge tone="amber">{t("scheduled")}</Badge>;
    if (a.ends_at && new Date(a.ends_at).getTime() <= now) return <Badge>{t("ended")}</Badge>;
    return <Badge tone="green">{t("live")}</Badge>;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-slate-500">{isSuper ? t("descriptionSuper") : t("descriptionAdmin")}</p>
        <Button onClick={() => setOpen(true)}>
          <Plus className="size-4" /> {t("add")}
        </Button>
      </div>
      {announcements.length === 0 ? (
        <EmptyState>{t("empty")}</EmptyState>
      ) : (
        <Card className="divide-y divide-slate-200 dark:divide-slate-800">
          {announcements.map((a) => (
            <div key={a.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  {status(a)}
                  <Badge tone={a.level === "warning" ? "amber" : "blue"}>{t(`levels.${a.level}`)}</Badge>
                  <Badge>{a.department_id ? deptName.get(a.department_id) : t("allCompany")}</Badge>
                </div>
                <p className="text-sm whitespace-pre-line">{a.message}</p>
                <p className="mt-1 text-xs text-slate-400">
                  {format.dateTime(new Date(a.starts_at), { dateStyle: "medium", timeStyle: "short" })}
                  {" → "}
                  {a.ends_at ? format.dateTime(new Date(a.ends_at), { dateStyle: "medium", timeStyle: "short" }) : t("noEnd")}
                </p>
              </div>
              <div className="flex gap-1.5">
                <Button size="sm" variant="secondary" onClick={() => toggle(a)}>
                  {a.is_active ? t("turnOff") : t("turnOn")}
                </Button>
                <Button size="sm" variant="ghost" className="text-red-600 dark:text-red-400" onClick={() => remove(a)} aria-label={t("delete")}>
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>
          ))}
        </Card>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title={t("addTitle")}>
        <form onSubmit={create} className="space-y-4">
          {error && <Alert>{error}</Alert>}
          <Field label={t("message")}>
            <textarea
              required
              maxLength={500}
              rows={3}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500 dark:border-slate-700 dark:bg-slate-900"
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("level")}>
              <Select value={level} onChange={(e) => setLevel(e.target.value as "info" | "warning")}>
                <option value="info">{t("levels.info")}</option>
                <option value="warning">{t("levels.warning")}</option>
              </Select>
            </Field>
            <Field label={t("audience")}>
              <Select value={dept} disabled={!isSuper} onChange={(e) => setDept(e.target.value)}>
                {isSuper && <option value="">{t("allCompany")}</option>}
                {departments
                  .filter((d) => isSuper || d.id === me.department_id)
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label={t("startsAt")}>
              <Input type="datetime-local" required value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
            </Field>
            <Field label={t("endsAt")}>
              <Input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              {t("cancel")}
            </Button>
            <Button type="submit">{t("publish")}</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
