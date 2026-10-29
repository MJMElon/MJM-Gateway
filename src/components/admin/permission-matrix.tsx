"use client";

import { Check, Search, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Department, Group, Module, Profile } from "@/lib/types";
import { ModuleIcon } from "@/components/module-icon";
import { Alert, cn, EmptyState, Input, Select } from "@/components/ui";

type Grant = { group_id: string; module_id: string };
type Override = { user_id: string; module_id: string; effect: "allow" | "deny" };
type Pair = { user_id: string; module_id: string };

const key = (a: string, b: string) => `${a}:${b}`;

export function PermissionMatrix({
  me,
  modules,
  groups,
  users,
  departments,
  grants: initialGrants,
  overrides: initialOverrides,
  members,
  effective: initialEffective,
}: {
  me: Profile;
  modules: Module[];
  groups: Group[];
  users: Profile[];
  departments: Department[];
  grants: Grant[];
  overrides: Override[];
  members: { group_id: string; user_id: string }[];
  effective: Pair[];
}) {
  const t = useTranslations("admin.matrix");
  const supabase = useMemo(() => createClient(), []);
  const isSuper = me.role === "super_admin";
  const [mode, setMode] = useState<"groups" | "users">("groups");
  const [query, setQuery] = useState("");
  const [dept, setDept] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [grants, setGrants] = useState(() => new Set(initialGrants.map((g) => key(g.group_id, g.module_id))));
  const [overrides, setOverrides] = useState(
    () => new Map(initialOverrides.map((o) => [key(o.user_id, o.module_id), o.effect])),
  );
  const [effective, setEffective] = useState(() => new Set(initialEffective.map((e) => key(e.user_id, e.module_id))));
  const myGroups = useMemo(() => new Set(members.filter((m) => m.user_id === me.id).map((m) => m.group_id)), [members, me.id]);

  // 与数据库 RLS 相同的规则；这里只用来决定格子能不能点，真正的检查在数据库
  const canGroup = (g: Group, m: Module) =>
    isSuper || (!!me.department_id && g.department_id === me.department_id && m.department_id === me.department_id && !myGroups.has(g.id));
  const canUser = (u: Profile, m: Module) =>
    isSuper ||
    (u.role === "user" && u.id !== me.id && !!me.department_id && u.department_id === me.department_id && m.department_id === me.department_id);

  const q = query.trim().toLowerCase();
  const columnsGroups = groups.filter((g) => (!q || g.name.toLowerCase().includes(q)) && (!dept || g.department_id === dept));
  const columnsUsers = users.filter(
    (u) => (!q || u.full_name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)) && (!dept || u.department_id === dept),
  );

  async function toggleGrant(g: Group, m: Module) {
    const k = key(g.id, m.id);
    const on = grants.has(k);
    setGrants((s) => {
      const n = new Set(s);
      if (on) n.delete(k);
      else n.add(k);
      return n;
    });
    const { error } = on
      ? await supabase.from("gw_group_modules").delete().eq("group_id", g.id).eq("module_id", m.id)
      : await supabase.from("gw_group_modules").insert({ group_id: g.id, module_id: m.id });
    if (error) {
      setError(t("saveFailed"));
      setGrants((s) => {
        const n = new Set(s);
        if (on) n.add(k);
        else n.delete(k);
        return n;
      });
    }
  }

  // 个人例外：跟随群组 → 个人允许 → 个人禁止 → 跟随群组
  async function cycleOverride(u: Profile, m: Module) {
    const k = key(u.id, m.id);
    const current = overrides.get(k);
    const next = current === undefined ? "allow" : current === "allow" ? "deny" : undefined;
    const { error } =
      next === undefined
        ? await supabase.from("gw_user_module_overrides").delete().eq("user_id", u.id).eq("module_id", m.id)
        : await supabase.from("gw_user_module_overrides").upsert({ user_id: u.id, module_id: m.id, effect: next });
    if (error) return setError(t("saveFailed"));
    setOverrides((map) => {
      const n = new Map(map);
      if (next) n.set(k, next);
      else n.delete(k);
      return n;
    });
    const { data } = await supabase.rpc("gw_admin_effective", { p_users: [u.id] });
    setEffective((s) => {
      const n = new Set([...s].filter((x) => !x.startsWith(`${u.id}:`)));
      ((data ?? []) as Pair[]).forEach((p) => n.add(key(p.user_id, p.module_id)));
      return n;
    });
  }

  const columns = mode === "groups" ? columnsGroups : columnsUsers;

  return (
    <div className="space-y-4">
      {error && <Alert>{error}</Alert>}
      <div className="flex flex-col gap-2 lg:flex-row">
        <div className="inline-flex rounded-lg border border-slate-300 p-0.5 dark:border-slate-700">
          {(["groups", "users"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={cn(
                "flex-1 rounded-md px-4 py-1.5 text-sm font-medium whitespace-nowrap",
                mode === m ? "bg-brand-600 text-white" : "text-slate-600 dark:text-slate-300",
              )}
            >
              {t(`mode.${m}`)}
            </button>
          ))}
        </div>
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t(`search.${mode}`)} className="pl-9" type="search" />
        </div>
        {isSuper && (
          <Select value={dept} onChange={(e) => setDept(e.target.value)} className="lg:w-44">
            <option value="">{t("allDepartments")}</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
        )}
      </div>

      {mode === "users" ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
          <span className="flex items-center gap-1"><Check className="size-3.5 text-slate-400" /> {t("legend.group")}</span>
          <span className="flex items-center gap-1"><Check className="size-3.5 text-emerald-600" /> {t("legend.allow")}</span>
          <span className="flex items-center gap-1"><X className="size-3.5 text-red-600" /> {t("legend.deny")}</span>
          <span>{t("legend.cycle")}</span>
        </div>
      ) : (
        !isSuper && <p className="text-xs text-slate-500">{t("adminHint")}</p>
      )}

      {modules.length === 0 || columns.length === 0 ? (
        <EmptyState>{t("empty")}</EmptyState>
      ) : (
        <div className="overflow-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <table className="min-w-full border-separate border-spacing-0 text-sm">
            <thead>
              <tr>
                <th className="sticky top-0 left-0 z-20 min-w-44 border-b border-slate-200 bg-slate-50 px-3 py-2 text-left font-medium dark:border-slate-800 dark:bg-slate-800">
                  {t("module")}
                </th>
                {columns.map((c) => (
                  <th
                    key={c.id}
                    className="sticky top-0 z-10 min-w-24 border-b border-slate-200 bg-slate-50 px-2 py-2 text-center text-xs font-medium dark:border-slate-800 dark:bg-slate-800"
                  >
                    <div className="max-w-28 truncate" title={"name" in c ? c.name : c.email}>
                      {"name" in c ? c.name : c.full_name}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {modules.map((m) => (
                <tr key={m.id} className={cn(!m.is_active && "opacity-50")}>
                  <td className="sticky left-0 z-10 border-b border-slate-100 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900">
                    <div className="flex items-center gap-2">
                      <ModuleIcon name={m.icon} className="size-4 shrink-0 text-slate-400" />
                      <span className="truncate">{m.name}</span>
                    </div>
                  </td>
                  {mode === "groups"
                    ? columnsGroups.map((g) => {
                        const on = grants.has(key(g.id, m.id));
                        const editable = canGroup(g, m);
                        return (
                          <td key={g.id} className="border-b border-slate-100 text-center dark:border-slate-800">
                            <input
                              type="checkbox"
                              checked={on}
                              disabled={!editable}
                              onChange={() => toggleGrant(g, m)}
                              className="size-5 cursor-pointer accent-brand-600 disabled:cursor-not-allowed disabled:opacity-40"
                              aria-label={`${g.name} · ${m.name}`}
                            />
                          </td>
                        );
                      })
                    : columnsUsers.map((u) => {
                        const ov = overrides.get(key(u.id, m.id));
                        const eff = effective.has(key(u.id, m.id));
                        const editable = canUser(u, m);
                        return (
                          <td key={u.id} className="border-b border-slate-100 p-0 text-center dark:border-slate-800">
                            <button
                              disabled={!editable}
                              onClick={() => cycleOverride(u, m)}
                              title={ov === "allow" ? t("legend.allow") : ov === "deny" ? t("legend.deny") : eff ? t("legend.group") : ""}
                              aria-label={`${u.full_name} · ${m.name}`}
                              className={cn(
                                "flex h-10 w-full items-center justify-center disabled:cursor-not-allowed",
                                editable && "hover:bg-slate-50 dark:hover:bg-slate-800",
                                ov === "allow" && "bg-emerald-50 dark:bg-emerald-950/40",
                                ov === "deny" && "bg-red-50 dark:bg-red-950/40",
                              )}
                            >
                              {ov === "deny" ? (
                                <X className="size-4 text-red-600" />
                              ) : ov === "allow" ? (
                                <Check className="size-4 text-emerald-600" />
                              ) : eff ? (
                                <Check className="size-4 text-slate-400" />
                              ) : null}
                            </button>
                          </td>
                        );
                      })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
