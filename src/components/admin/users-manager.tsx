"use client";

import { Download, Eye, KeyRound, Pencil, Search, Upload, UserPlus } from "lucide-react";
import { useTranslations, type Messages } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import {
  createUser, importUsers, resetUserPassword, setUserStatus, updateUser, type CreateUserResult,
} from "@/app/(app)/admin/users/actions";
import type { Department, Group, Profile, Role } from "@/lib/types";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Modal, Select } from "@/components/ui";

type Member = { group_id: string; user_id: string };
type UserError = keyof Messages["admin"]["users"]["errors"];
type ImportError = keyof Messages["admin"]["users"]["import"]["errors"];

export function UsersManager({
  me,
  users,
  departments,
  groups,
  members,
}: {
  me: Profile;
  users: Profile[];
  departments: Department[];
  groups: Group[];
  members: Member[];
}) {
  const t = useTranslations("admin.users");
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [deptFilter, setDeptFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [editing, setEditing] = useState<Profile | "new" | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [secret, setSecret] = useState<{ email: string; password: string } | null>(null);
  const [message, setMessage] = useState<{ tone: "green" | "red"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const isSuper = me.role === "super_admin";
  const deptName = useMemo(() => new Map(departments.map((d) => [d.id, d.name])), [departments]);
  const groupsOf = (userId: string) => members.filter((m) => m.user_id === userId).map((m) => m.group_id);
  const groupName = useMemo(() => new Map(groups.map((g) => [g.id, g.name])), [groups]);

  const q = query.trim().toLowerCase();
  const filtered = users.filter(
    (u) =>
      (!q || u.full_name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)) &&
      (!deptFilter || u.department_id === deptFilter) &&
      (!statusFilter || u.status === statusFilter),
  );

  const canManage = (u: Profile) => isSuper || (u.role === "user" && u.id !== me.id && u.department_id === me.department_id);

  function run(action: () => Promise<{ ok: boolean; error?: string }>, okText: string) {
    startTransition(async () => {
      const result = await action();
      setMessage(result.ok ? { tone: "green", text: okText } : { tone: "red", text: t(`errors.${(result.error ?? "forbidden") as UserError}`) });
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      {message && <Alert tone={message.tone}>{message.text}</Alert>}

      <div className="flex flex-col gap-2 lg:flex-row">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("search")} className="pl-9" type="search" />
        </div>
        <div className="grid grid-cols-2 gap-2 lg:flex">
          {isSuper && (
            <Select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)} className="lg:w-40">
              <option value="">{t("allDepartments")}</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          )}
          <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="lg:w-32">
            <option value="">{t("allStatus")}</option>
            <option value="active">{t("status.active")}</option>
            <option value="disabled">{t("status.disabled")}</option>
          </Select>
          <Button variant="secondary" onClick={() => setImportOpen(true)}>
            <Upload className="size-4" /> {t("import.button")}
          </Button>
          <Button onClick={() => setEditing("new")}>
            <UserPlus className="size-4" /> {t("add")}
          </Button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState>{t("empty")}</EmptyState>
      ) : (
        <Card className="divide-y divide-slate-200 dark:divide-slate-800">
          {filtered.map((u) => (
            <div key={u.id} className="flex flex-col gap-3 p-4 md:flex-row md:items-center">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{u.full_name}</span>
                  <Badge tone={u.role === "super_admin" ? "red" : u.role === "admin" ? "amber" : "slate"}>{t(`roles.${u.role}`)}</Badge>
                  {u.status === "disabled" && <Badge tone="red">{t("status.disabled")}</Badge>}
                  {u.must_change_password && <Badge>{t("mustChange")}</Badge>}
                </div>
                <div className="mt-0.5 truncate text-sm text-slate-500">
                  {u.email} · {u.department_id ? deptName.get(u.department_id) : t("noDepartment")}
                </div>
                {groupsOf(u.id).length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {groupsOf(u.id).map((g) => (
                      <Badge key={g} tone="blue">
                        {groupName.get(g)}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Link href={`/admin/preview/${u.id}`}>
                  <Button size="sm" variant="ghost">
                    <Eye className="size-4" /> {t("preview")}
                  </Button>
                </Link>
                {canManage(u) && (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(u)}>
                      <Pencil className="size-4" /> {t("edit")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={() =>
                        startTransition(async () => {
                          const r = await resetUserPassword(u.id);
                          if (r.ok) setSecret({ email: u.email, password: r.password });
                          else setMessage({ tone: "red", text: t(`errors.${r.error as UserError}`) });
                        })
                      }
                    >
                      <KeyRound className="size-4" /> {t("resetPassword")}
                    </Button>
                    {u.id !== me.id && (
                      <Button
                        size="sm"
                        variant={u.status === "active" ? "ghost" : "secondary"}
                        className={u.status === "active" ? "text-red-600 dark:text-red-400" : ""}
                        disabled={pending}
                        onClick={() =>
                          run(
                            () => setUserStatus(u.id, u.status === "active" ? "disabled" : "active"),
                            u.status === "active" ? t("disabledOk") : t("enabledOk"),
                          )
                        }
                      >
                        {u.status === "active" ? t("disable") : t("enable")}
                      </Button>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}
        </Card>
      )}

      {editing && (
        <UserDialog
          me={me}
          user={editing === "new" ? null : editing}
          departments={departments}
          groups={groups}
          currentGroups={editing === "new" ? [] : groupsOf(editing.id)}
          onClose={() => setEditing(null)}
          onCreated={(r) => {
            setEditing(null);
            if (r.password) setSecret({ email: r.email, password: r.password });
            else setMessage({ tone: "green", text: r.linked ? t("linkedOk") : t("createdOk") });
            router.refresh();
          }}
          onSaved={() => {
            setEditing(null);
            setMessage({ tone: "green", text: t("savedOk") });
            router.refresh();
          }}
        />
      )}

      {importOpen && <ImportDialog onClose={() => { setImportOpen(false); router.refresh(); }} />}

      {secret && (
        <Modal open onClose={() => setSecret(null)} title={t("tempPasswordTitle")}>
          <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">{t("tempPasswordBody", { email: secret.email })}</p>
          <div className="mb-4 rounded-lg bg-slate-100 p-3 text-center font-mono text-lg tracking-wider select-all dark:bg-slate-800">
            {secret.password}
          </div>
          <Alert tone="amber">{t("tempPasswordWarning")}</Alert>
          <div className="mt-4 flex justify-end">
            <Button onClick={() => setSecret(null)}>{t("done")}</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function UserDialog({
  me,
  user,
  departments,
  groups,
  currentGroups,
  onClose,
  onCreated,
  onSaved,
}: {
  me: Profile;
  user: Profile | null;
  departments: Department[];
  groups: Group[];
  currentGroups: string[];
  onClose: () => void;
  onCreated: (r: Extract<CreateUserResult, { ok: true }>) => void;
  onSaved: () => void;
}) {
  const t = useTranslations("admin.users");
  const isSuper = me.role === "super_admin";
  const [email, setEmail] = useState(user?.email ?? "");
  const [name, setName] = useState(user?.full_name ?? "");
  const [dept, setDept] = useState(user?.department_id ?? (isSuper ? "" : me.department_id ?? ""));
  const [role, setRole] = useState<Role>(user?.role ?? "user");
  const [selected, setSelected] = useState<string[]>(currentGroups);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // admin 只能指定本部门群组；super_admin 可指定全部
  const assignable = groups.filter((g) => isSuper || g.department_id === me.department_id);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      if (user) {
        const r = await updateUser(user.id, { full_name: name, department_id: dept || null, role, group_ids: selected });
        if (r.ok) onSaved();
        else setError(t(`errors.${r.error as UserError}`));
      } else {
        const r = await createUser({ email, full_name: name, department_id: dept || null, role, group_ids: selected });
        if (r.ok) onCreated(r);
        else setError(t(`errors.${r.error as UserError}`));
      }
    });
  }

  return (
    <Modal open onClose={onClose} title={user ? t("editTitle") : t("addTitle")}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field label="Email">
          <Input type="email" required value={email} disabled={!!user} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label={t("name")}>
          <Input required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t("department")}>
          <Select value={dept} disabled={!isSuper} onChange={(e) => setDept(e.target.value)}>
            <option value="">{t("noDepartment")}</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.code})
              </option>
            ))}
          </Select>
        </Field>
        {isSuper && (
          <Field label={t("role")}>
            <Select value={role} onChange={(e) => setRole(e.target.value as Role)} disabled={user?.id === me.id}>
              <option value="user">{t("roles.user")}</option>
              <option value="admin">{t("roles.admin")}</option>
              <option value="super_admin">{t("roles.super_admin")}</option>
            </Select>
          </Field>
        )}
        <div>
          <p className="mb-1.5 text-sm font-medium text-slate-700 dark:text-slate-300">{t("groups")}</p>
          {assignable.length === 0 ? (
            <p className="text-sm text-slate-500">{t("noGroups")}</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {assignable.map((g) => {
                const on = selected.includes(g.id);
                return (
                  <button
                    type="button"
                    key={g.id}
                    onClick={() => setSelected((s) => (on ? s.filter((x) => x !== g.id) : [...s, g.id]))}
                    className={
                      on
                        ? "rounded-full border border-brand-500 bg-brand-50 px-3 py-1 text-sm text-brand-700 dark:bg-brand-700/20 dark:text-brand-100"
                        : "rounded-full border border-slate-300 px-3 py-1 text-sm text-slate-600 dark:border-slate-700 dark:text-slate-300"
                    }
                  >
                    {g.name}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {!user && <p className="text-xs text-slate-500">{t("passwordHint")}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button type="submit" disabled={pending}>
            {user ? t("save") : t("create")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ImportDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslations("admin.users.import");
  const tu = useTranslations("admin.users");
  const [results, setResults] = useState<CreateUserResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function downloadPasswords() {
    if (!results) return;
    const lines = ["email,password,result", ...results.map((r) => `${r.email},${r.ok ? r.password ?? "" : ""},${r.ok ? "OK" : r.error}`)];
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "gateway-import-result.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <Modal open onClose={onClose} title={t("title")} wide>
      {!results ? (
        <form
          className="space-y-4"
          action={(fd) =>
            startTransition(async () => {
              const r = await importUsers(fd);
              if (r.error) setError(t(`errors.${r.error as ImportError}`));
              else setResults(r.results);
            })
          }
        >
          <p className="text-sm text-slate-600 dark:text-slate-300">{t("description")}</p>
          <a href="/admin/users/template" className="inline-flex items-center gap-1.5 text-sm text-brand-600 hover:underline dark:text-brand-100">
            <Download className="size-4" /> {t("template")}
          </a>
          {error && <Alert>{error}</Alert>}
          <Input type="file" name="file" accept=".xlsx" required className="h-auto py-2" />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              {tu("cancel")}
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? t("importing") : t("submit")}
            </Button>
          </div>
        </form>
      ) : (
        <div className="space-y-4">
          <Alert tone="green">
            {t("summary", { ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length })}
          </Alert>
          <div className="max-h-72 overflow-y-auto rounded-lg border border-slate-200 text-sm dark:border-slate-800">
            {results.map((r, i) => (
              <div key={i} className="flex items-center justify-between gap-2 border-b border-slate-100 px-3 py-2 last:border-0 dark:border-slate-800">
                <span className="truncate">{r.email}</span>
                {r.ok ? (
                  <Badge tone="green">{r.linked ? tu("linked") : "OK"}</Badge>
                ) : (
                  <Badge tone="red">{tu(`errors.${r.error as UserError}`)}</Badge>
                )}
              </div>
            ))}
          </div>
          <Alert tone="amber">{t("passwordWarning")}</Alert>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={downloadPasswords}>
              <Download className="size-4" /> {t("downloadResult")}
            </Button>
            <Button onClick={onClose}>{tu("done")}</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
