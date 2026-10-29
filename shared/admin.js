/* ================================================================
   MJM Gateway — 权限后台
   分页：用户、权限矩阵、群组、模块、部门、公告、操作记录、预览（#preview=用户id）
   读写都以当前用户身份直接连 Supabase，RLS 决定能看、能改什么；
   需要 service_role 的动作（建立用户、重设密码、停用、API Key）走 gw-admin Edge Function。
   ================================================================ */
(async function () {
  const { sb, t, esc, $, $$, icon, moduleIcon, cls, btn, badge, alertBox, modal, confirmDialog, toast, invoke, refreshIcons, fmtDateTime } = GW;
  const me = await GW.requireProfile("admin");
  if (!me) return;
  const isSuper = me.role === "super_admin";
  const main = GW.shell(me, "admin");

  const TABS = [
    ["users", t("admin.tabs.users")],
    ["matrix", t("admin.tabs.matrix")],
    ...(isSuper
      ? [
          ["groups", t("admin.tabs.groups")],
          ["modules", t("admin.tabs.modules")],
          ["departments", t("admin.tabs.departments")],
        ]
      : []),
    ["announcements", t("admin.tabs.announcements")],
    ["audit", t("admin.tabs.audit")],
  ];

  main.innerHTML = `<div class="space-y-5">
    <div>
      <h1 class="text-xl font-semibold sm:text-2xl">${esc(t("admin.title"))}</h1>
      <p class="mt-1 text-sm text-slate-500">${esc(isSuper ? t("admin.roleSuper") : t("admin.roleAdmin"))}</p>
    </div>
    <div class="-mx-4 overflow-x-auto px-4">
      <nav id="tabs" class="flex min-w-max gap-1 border-b border-slate-200 dark:border-slate-800"></nav>
    </div>
    <div id="msg"></div>
    <div id="view"></div>
  </div>`;
  const view = $("#view");
  let routeSeq = 0;
  // 资料载入完时，若使用者已切到别的分页就不要再画
  const stale = (seq) => seq !== routeSeq;

  function setMsg(text, tone) {
    $("#msg").innerHTML = text ? alertBox(text, tone) : "";
  }

  // ---------------------------------------------------------------- 共用
  const field = (label, input, hint) => `<label class="block space-y-1.5"><span class="${cls.label}">${esc(label)}</span>${input}${
    hint ? `<span class="block text-xs text-slate-500">${esc(hint)}</span>` : ""
  }</label>`;
  const select = (name, options, value, attrs) =>
    `<select name="${name}" class="${cls.input}" ${attrs || ""}>${options
      .map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value == null ? "" : value) ? "selected" : ""}>${esc(l)}</option>`)
      .join("")}</select>`;
  const searchBox = (id, placeholder) => `<div class="relative flex-1">
      <span class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400">${icon("search")}</span>
      <input id="${id}" type="search" placeholder="${esc(placeholder)}" class="${cls.input} pl-9">
    </div>`;
  const empty = (text) => `<div class="${cls.empty}">${esc(text)}</div>`;

  async function loadDepartments() {
    const { data } = await sb.from("gw_departments").select("id, code, name").order("code");
    return data || [];
  }

  function showSecret(title, body, secret, warning) {
    const m = modal(
      title,
      `<p class="mb-3 text-sm text-slate-600 dark:text-slate-300">${esc(body)}</p>
       <div class="mb-4 rounded-lg bg-slate-100 p-3 text-center font-mono text-lg tracking-wider break-all select-all dark:bg-slate-800">${esc(secret)}</div>
       ${alertBox(warning, "amber")}
       <div class="mt-4 flex justify-end"><button data-done class="${btn("primary")}">${esc(t("admin.users.done"))}</button></div>`,
    );
    m.el.querySelector("[data-done]").onclick = m.close;
  }

  // ================================================================ 用户
  async function usersTab() {
    const seq = routeSeq;
    const tu = (k, v) => t("admin.users." + k, v);
    const [users, departments, groups, members] = await Promise.all([
      sb.from("gw_profiles").select("*").order("created_at", { ascending: false }),
      loadDepartments(),
      sb.from("gw_groups").select("*").order("sort_order").order("name"),
      sb.from("gw_group_members").select("group_id, user_id"),
    ]).then(([u, d, g, m]) => [u.data || [], d, g.data || [], m.data || []]);
    const deptName = new Map(departments.map((d) => [d.id, d.name]));
    const groupName = new Map(groups.map((g) => [g.id, g.name]));
    const groupsOf = (id) => members.filter((m) => m.user_id === id).map((m) => m.group_id);
    const canManage = (u) => isSuper || (u.role === "user" && u.id !== me.id && u.department_id === me.department_id);
    const roleTone = { super_admin: "red", admin: "amber", user: "slate" };
    const filter = { q: "", dept: "", status: "" };

    if (stale(seq)) return;
    view.innerHTML = `<div class="space-y-4">
      <div class="flex flex-col gap-2 lg:flex-row">
        ${searchBox("q", tu("search"))}
        <div class="grid grid-cols-2 gap-2 lg:flex">
          ${isSuper ? `<select id="dept" class="${cls.input} lg:w-40"><option value="">${esc(tu("allDepartments"))}</option>${departments.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join("")}</select>` : ""}
          <select id="status" class="${cls.input} lg:w-32">
            <option value="">${esc(tu("allStatus"))}</option>
            <option value="active">${esc(tu("status.active"))}</option>
            <option value="disabled">${esc(tu("status.disabled"))}</option>
          </select>
          <button id="import" class="${btn("secondary")}">${icon("upload")} ${esc(tu("import.button"))}</button>
          <button id="add" class="${btn("primary")}">${icon("user-plus")} ${esc(tu("add"))}</button>
        </div>
      </div>
      <div id="list"></div>
    </div>`;

    function drawList() {
      const q = filter.q.trim().toLowerCase();
      const list = users.filter(
        (u) =>
          (!q || u.full_name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)) &&
          (!filter.dept || u.department_id === filter.dept) &&
          (!filter.status || u.status === filter.status),
      );
      $("#list").innerHTML = list.length
        ? `<div class="${cls.card} divide-y divide-slate-200 dark:divide-slate-800">${list
            .map(
              (u) => `<div class="flex flex-col gap-3 p-4 md:flex-row md:items-center">
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="font-medium">${esc(u.full_name)}</span>
                    ${badge(tu("roles." + u.role), roleTone[u.role])}
                    ${u.status === "disabled" ? badge(tu("status.disabled"), "red") : ""}
                    ${u.must_change_password ? badge(tu("mustChange")) : ""}
                  </div>
                  <div class="mt-0.5 truncate text-sm text-slate-500">${esc(u.email)} · ${esc(u.department_id ? deptName.get(u.department_id) : tu("noDepartment"))}</div>
                  ${groupsOf(u.id).length ? `<div class="mt-1 flex flex-wrap gap-1">${groupsOf(u.id).map((g) => badge(groupName.get(g), "blue")).join("")}</div>` : ""}
                </div>
                <div class="flex flex-wrap gap-1.5">
                  <a href="#preview=${u.id}" class="${btn("ghost", "sm")}">${icon("eye")} ${esc(tu("preview"))}</a>
                  ${
                    canManage(u)
                      ? `<button data-edit="${u.id}" class="${btn("ghost", "sm")}">${icon("pencil")} ${esc(tu("edit"))}</button>
                         <button data-reset="${u.id}" class="${btn("ghost", "sm")}">${icon("key-round")} ${esc(tu("resetPassword"))}</button>
                         ${
                           u.id !== me.id
                             ? `<button data-status="${u.id}" class="${btn(u.status === "active" ? "ghost" : "secondary", "sm")} ${u.status === "active" ? "text-red-600 dark:text-red-400" : ""}">${esc(u.status === "active" ? tu("disable") : tu("enable"))}</button>`
                             : ""
                         }`
                      : ""
                  }
                </div>
              </div>`,
            )
            .join("")}</div>`
        : empty(tu("empty"));
      refreshIcons();
    }

    function userDialog(user) {
      const current = user ? groupsOf(user.id) : [];
      const selected = new Set(current);
      const assignable = groups.filter((g) => isSuper || g.department_id === me.department_id);
      const m = modal(
        user ? tu("editTitle") : tu("addTitle"),
        `<form class="space-y-4">
          <div data-err></div>
          ${field("Email", `<input name="email" type="email" required value="${esc(user ? user.email : "")}" ${user ? "disabled" : ""} class="${cls.input}">`)}
          ${field(tu("name"), `<input name="full_name" required value="${esc(user ? user.full_name : "")}" class="${cls.input}">`)}
          ${field(
            tu("department"),
            select(
              "department_id",
              [["", tu("noDepartment")], ...departments.map((d) => [d.id, `${d.name} (${d.code})`])],
              user ? user.department_id : isSuper ? "" : me.department_id,
              isSuper ? "" : "disabled",
            ),
          )}
          ${
            isSuper
              ? field(
                  tu("role"),
                  select("role", [["user", tu("roles.user")], ["admin", tu("roles.admin")], ["super_admin", tu("roles.super_admin")]], user ? user.role : "user", user && user.id === me.id ? "disabled" : ""),
                )
              : ""
          }
          <div>
            <p class="mb-1.5 ${cls.label}">${esc(tu("groups"))}</p>
            ${
              assignable.length
                ? `<div class="flex flex-wrap gap-2">${assignable.map((g) => `<button type="button" data-group="${g.id}" class="rounded-full border px-3 py-1 text-sm">${esc(g.name)}</button>`).join("")}</div>`
                : `<p class="text-sm text-slate-500">${esc(tu("noGroups"))}</p>`
            }
          </div>
          ${user ? "" : `<p class="text-xs text-slate-500">${esc(tu("passwordHint"))}</p>`}
          <div class="flex justify-end gap-2">
            <button type="button" data-cancel class="${btn("secondary")}">${esc(tu("cancel"))}</button>
            <button type="submit" class="${btn("primary")}">${esc(user ? tu("save") : tu("create"))}</button>
          </div>
        </form>`,
      );
      const paint = () =>
        $$("[data-group]", m.el).forEach((b) => {
          const on = selected.has(b.dataset.group);
          b.className = `rounded-full border px-3 py-1 text-sm ${
            on ? "border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-700/20 dark:text-brand-100" : "border-slate-300 text-slate-600 dark:border-slate-700 dark:text-slate-300"
          }`;
        });
      $$("[data-group]", m.el).forEach((b) =>
        b.addEventListener("click", () => {
          const id = b.dataset.group;
          selected.has(id) ? selected.delete(id) : selected.add(id);
          paint();
        }),
      );
      paint();
      $("[data-cancel]", m.el).onclick = m.close;
      $("form", m.el).addEventListener("submit", async (e) => {
        e.preventDefault();
        const f = e.target;
        const submit = $("button[type=submit]", f);
        submit.disabled = true;
        const input = {
          full_name: f.full_name.value.trim(),
          department_id: f.department_id.value || null,
          role: f.role ? f.role.value : user ? user.role : "user",
          group_ids: [...selected],
        };
        let r;
        if (user) {
          r = await updateUser(user.id, input);
        } else {
          r = await invoke("gw-admin", { action: "create_user", user: { ...input, email: f.email.value.trim() } });
        }
        submit.disabled = false;
        if (!r || !r.ok) return ($("[data-err]", m.el).innerHTML = alertBox(tu("errors." + ((r && r.error) || "forbidden"))));
        m.close();
        if (r.password) showSecret(tu("tempPasswordTitle"), tu("tempPasswordBody", { email: r.email }), r.password, tu("tempPasswordWarning"));
        else setMsg(user ? tu("savedOk") : r.linked ? tu("linkedOk") : tu("createdOk"), "green");
        usersTab();
      });
    }

    // 编辑用户：直接以用户身份写入，RLS 与 gw_profiles_guard 检查权限
    async function updateUser(id, input) {
      const { data: cur } = await sb.from("gw_profiles").select("full_name, department_id, role").eq("id", id).single();
      if (!cur) return { ok: false, error: "forbidden" };
      const patch = {};
      if (input.full_name && input.full_name !== cur.full_name) patch.full_name = input.full_name;
      if (input.department_id !== cur.department_id) patch.department_id = input.department_id;
      if (input.role !== cur.role) patch.role = input.role;
      if (Object.keys(patch).length) {
        const { data, error } = await sb.from("gw_profiles").update(patch).eq("id", id).select("id");
        if (error || !data || !data.length) return { ok: false, error: "forbidden" };
      }
      const visible = new Set(groups.map((g) => g.id));
      const before = new Set(groupsOf(id).filter((g) => visible.has(g)));
      const toAdd = input.group_ids.filter((g) => !before.has(g));
      const toRemove = [...before].filter((g) => !input.group_ids.includes(g));
      if (toAdd.length) {
        const { error } = await sb.from("gw_group_members").insert(toAdd.map((group_id) => ({ group_id, user_id: id })));
        if (error) return { ok: false, error: "forbidden" };
      }
      if (toRemove.length) {
        const { error } = await sb.from("gw_group_members").delete().eq("user_id", id).in("group_id", toRemove);
        if (error) return { ok: false, error: "forbidden" };
      }
      return { ok: true };
    }

    function importDialog() {
      const ti = (k, v) => t("admin.users.import." + k, v);
      const m = modal(
        ti("title"),
        `<form class="space-y-4">
          <p class="text-sm text-slate-600 dark:text-slate-300">${esc(ti("description"))}</p>
          <button type="button" data-template class="inline-flex items-center gap-1.5 text-sm text-brand-600 hover:underline dark:text-brand-100">${icon("download")} ${esc(ti("template"))}</button>
          <div data-err></div>
          <input type="file" name="file" accept=".xlsx" required class="${cls.input} h-auto py-2">
          <div class="flex justify-end gap-2">
            <button type="button" data-cancel class="${btn("secondary")}">${esc(tu("cancel"))}</button>
            <button type="submit" class="${btn("primary")}">${esc(ti("submit"))}</button>
          </div>
        </form>`,
        { wide: true, onClose: () => location.hash.replace("#", "") === "users" || !location.hash ? usersTab() : null },
      );
      $("[data-cancel]", m.el).onclick = m.close;
      $("[data-template]", m.el).onclick = () =>
        GW.downloadXlsx("gateway-users-template.xlsx", (wb) => {
          const sheet = wb.addWorksheet("users");
          sheet.columns = [
            { header: "email", width: 30 },
            { header: ti("colName"), width: 16 },
            { header: ti("colDepartment"), width: 14 },
            { header: ti("colGroups"), width: 30 },
            { header: ti("colRole"), width: 12 },
          ];
          sheet.addRow(["someone@example.com", "张三", "HQ", "全体员工, 总部车队", "user"]);
          sheet.getRow(1).font = { bold: true };
        });
      $("form", m.el).addEventListener("submit", async (e) => {
        e.preventDefault();
        const err = (k) => ($("[data-err]", m.el).innerHTML = alertBox(ti("errors." + k)));
        const file = e.target.file.files[0];
        if (!file) return err("no_file");
        const submit = $("button[type=submit]", e.target);
        submit.disabled = true;
        submit.textContent = ti("importing");
        const rows = await GW.readXlsxRows(file);
        if (!rows) return (submit.disabled = false), (submit.textContent = ti("submit")), err("bad_file");
        if (rows.length > 500) return (submit.disabled = false), (submit.textContent = ti("submit")), err("too_many");
        const r = await invoke("gw-admin", {
          action: "import_users",
          rows: rows
            .filter((c) => c[0])
            .map(([email, full_name, department_code, groupsCell, role]) => ({
              email,
              full_name,
              department_code,
              groups: groupsCell.split(/[,，]/).map((g) => g.trim()).filter(Boolean),
              role,
            })),
        });
        if (!r || r.error) return (submit.disabled = false), (submit.textContent = ti("submit")), err((r && r.error) || "bad_file");
        const results = r.results || [];
        m.el.innerHTML = `<div class="space-y-4">
          ${alertBox(ti("summary", { ok: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length }), "green")}
          <div class="max-h-72 overflow-y-auto rounded-lg border border-slate-200 text-sm dark:border-slate-800">
            ${results
              .map(
                (x) => `<div class="flex items-center justify-between gap-2 border-b border-slate-100 px-3 py-2 last:border-0 dark:border-slate-800">
                  <span class="truncate">${esc(x.email)}</span>${x.ok ? badge(x.linked ? tu("linked") : "OK", "green") : badge(tu("errors." + x.error), "red")}
                </div>`,
              )
              .join("")}
          </div>
          ${alertBox(ti("passwordWarning"), "amber")}
          <div class="flex justify-end gap-2">
            <button data-csv class="${btn("secondary")}">${icon("download")} ${esc(ti("downloadResult"))}</button>
            <button data-done class="${btn("primary")}">${esc(tu("done"))}</button>
          </div>
        </div>`;
        refreshIcons();
        $("[data-done]", m.el).onclick = m.close;
        $("[data-csv]", m.el).onclick = () => {
          const lines = ["email,password,result", ...results.map((x) => `${x.email},${x.ok ? x.password || "" : ""},${x.ok ? "OK" : x.error}`)];
          GW.downloadBlob("gateway-import-result.csv", new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" }));
        };
      });
    }

    $("#q").addEventListener("input", (e) => ((filter.q = e.target.value), drawList()));
    if ($("#dept")) $("#dept").addEventListener("change", (e) => ((filter.dept = e.target.value), drawList()));
    $("#status").addEventListener("change", (e) => ((filter.status = e.target.value), drawList()));
    $("#add").onclick = () => userDialog(null);
    $("#import").onclick = importDialog;
    $("#list").addEventListener("click", async (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      const user = users.find((u) => u.id === (b.dataset.edit || b.dataset.reset || b.dataset.status));
      if (!user) return;
      if (b.dataset.edit) return userDialog(user);
      b.disabled = true;
      if (b.dataset.reset) {
        const r = await invoke("gw-admin", { action: "reset_password", id: user.id });
        b.disabled = false;
        if (r && r.ok) showSecret(tu("tempPasswordTitle"), tu("tempPasswordBody", { email: user.email }), r.password, tu("tempPasswordWarning"));
        else setMsg(tu("errors." + ((r && r.error) || "forbidden")));
        return;
      }
      const status = user.status === "active" ? "disabled" : "active";
      const r = await invoke("gw-admin", { action: "set_status", id: user.id, status });
      if (r && r.ok) setMsg(status === "disabled" ? tu("disabledOk") : tu("enabledOk"), "green");
      else setMsg(tu("errors." + ((r && r.error) || "forbidden")));
      usersTab();
    });
    drawList();
  }

  // ================================================================ 权限矩阵
  async function matrixTab() {
    const seq = routeSeq;
    const tm = (k, v) => t("admin.matrix." + k, v);
    const [modules, groups, users, grantsRows, overridesRows, members, departments] = await Promise.all([
      sb.from("gw_modules").select("*").order("sort_order").order("name"),
      sb.from("gw_groups").select("*").order("sort_order").order("name"),
      sb.from("gw_profiles").select("*").eq("status", "active").order("full_name"),
      sb.from("gw_group_modules").select("group_id, module_id"),
      sb.from("gw_user_module_overrides").select("user_id, module_id, effect"),
      sb.from("gw_group_members").select("group_id, user_id"),
      loadDepartments(),
    ]).then((r) => r.map((x) => (Array.isArray(x) ? x : x.data || [])));
    const key = (a, b) => a + ":" + b;
    const grants = new Set(grantsRows.map((g) => key(g.group_id, g.module_id)));
    const overrides = new Map(overridesRows.map((o) => [key(o.user_id, o.module_id), o.effect]));
    let effective = new Set();
    if (users.length) {
      const { data } = await sb.rpc("gw_admin_effective", { p_users: users.map((u) => u.id) });
      effective = new Set((data || []).map((e) => key(e.user_id, e.module_id)));
    }
    const myGroups = new Set(members.filter((m) => m.user_id === me.id).map((m) => m.group_id));
    // 与数据库 RLS 相同的规则；这里只决定格子能不能点，真正的检查在数据库
    const canGroup = (g, m) =>
      isSuper || (!!me.department_id && g.department_id === me.department_id && m.department_id === me.department_id && !myGroups.has(g.id));
    const canUser = (u, m) =>
      isSuper || (u.role === "user" && u.id !== me.id && !!me.department_id && u.department_id === me.department_id && m.department_id === me.department_id);
    let mode = "groups";
    let q = "";
    let dept = "";

    if (stale(seq)) return;
    view.innerHTML = `<div class="space-y-4">
      <div class="flex flex-col gap-2 lg:flex-row">
        <div id="mode" class="inline-flex rounded-lg border border-slate-300 p-0.5 dark:border-slate-700">
          ${["groups", "users"].map((m) => `<button data-mode="${m}" class="flex-1 rounded-md px-4 py-1.5 text-sm font-medium whitespace-nowrap">${esc(tm("mode." + m))}</button>`).join("")}
        </div>
        ${searchBox("q", "")}
        ${isSuper ? `<select id="dept" class="${cls.input} lg:w-44"><option value="">${esc(tm("allDepartments"))}</option>${departments.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join("")}</select>` : ""}
      </div>
      <div id="legend"></div>
      <div id="table"></div>
    </div>`;

    function draw() {
      $$("[data-mode]").forEach((b) => (b.className = `flex-1 rounded-md px-4 py-1.5 text-sm font-medium whitespace-nowrap ${b.dataset.mode === mode ? "bg-brand-600 text-white" : "text-slate-600 dark:text-slate-300"}`));
      $("#q").placeholder = tm("search." + mode);
      $("#legend").innerHTML =
        mode === "users"
          ? `<div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
              <span class="flex items-center gap-1">${icon("check", "size-3.5 text-slate-400")} ${esc(tm("legend.group"))}</span>
              <span class="flex items-center gap-1">${icon("check", "size-3.5 text-emerald-600")} ${esc(tm("legend.allow"))}</span>
              <span class="flex items-center gap-1">${icon("x", "size-3.5 text-red-600")} ${esc(tm("legend.deny"))}</span>
              <span>${esc(tm("legend.cycle"))}</span></div>`
          : isSuper
            ? ""
            : `<p class="text-xs text-slate-500">${esc(tm("adminHint"))}</p>`;
      const ql = q.trim().toLowerCase();
      const cols =
        mode === "groups"
          ? groups.filter((g) => (!ql || g.name.toLowerCase().includes(ql)) && (!dept || g.department_id === dept))
          : users.filter((u) => (!ql || u.full_name.toLowerCase().includes(ql) || u.email.toLowerCase().includes(ql)) && (!dept || u.department_id === dept));
      if (!modules.length || !cols.length) {
        $("#table").innerHTML = empty(tm("empty"));
        return refreshIcons();
      }
      const cell = (c, m) => {
        if (mode === "groups") {
          const on = grants.has(key(c.id, m.id));
          return `<td class="border-b border-slate-100 text-center dark:border-slate-800"><input type="checkbox" data-g="${c.id}" data-m="${m.id}" ${on ? "checked" : ""} ${canGroup(c, m) ? "" : "disabled"} aria-label="${esc(c.name + " · " + m.name)}" class="size-5 cursor-pointer accent-brand-600 disabled:cursor-not-allowed disabled:opacity-40"></td>`;
        }
        const ov = overrides.get(key(c.id, m.id));
        const eff = effective.has(key(c.id, m.id));
        const title = ov === "allow" ? tm("legend.allow") : ov === "deny" ? tm("legend.deny") : eff ? tm("legend.group") : "";
        const mark = ov === "deny" ? icon("x", "size-4 text-red-600") : ov === "allow" ? icon("check", "size-4 text-emerald-600") : eff ? icon("check", "size-4 text-slate-400") : "";
        return `<td class="border-b border-slate-100 p-0 text-center dark:border-slate-800"><button data-u="${c.id}" data-m="${m.id}" ${canUser(c, m) ? "" : "disabled"} title="${esc(title)}" aria-label="${esc(c.full_name + " · " + m.name)}" class="flex h-10 w-full items-center justify-center disabled:cursor-not-allowed ${ov === "allow" ? "bg-emerald-50 dark:bg-emerald-950/40" : ov === "deny" ? "bg-red-50 dark:bg-red-950/40" : "hover:bg-slate-50 dark:hover:bg-slate-800"}">${mark}</button></td>`;
      };
      $("#table").innerHTML = `<div class="overflow-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <table class="min-w-full border-separate border-spacing-0 text-sm">
          <thead><tr>
            <th class="sticky top-0 left-0 z-20 min-w-44 border-b border-slate-200 bg-slate-50 px-3 py-2 text-left font-medium dark:border-slate-800 dark:bg-slate-800">${esc(tm("module"))}</th>
            ${cols.map((c) => `<th class="sticky top-0 z-10 min-w-24 border-b border-slate-200 bg-slate-50 px-2 py-2 text-center text-xs font-medium dark:border-slate-800 dark:bg-slate-800"><div class="max-w-28 truncate" title="${esc(c.email || c.name)}">${esc(c.full_name || c.name)}</div></th>`).join("")}
          </tr></thead>
          <tbody>${modules
            .map(
              (m) => `<tr class="${m.is_active ? "" : "opacity-50"}">
                <td class="sticky left-0 z-10 border-b border-slate-100 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900"><div class="flex items-center gap-2">${moduleIcon(m.icon, "size-4 shrink-0 text-slate-400")}<span class="truncate">${esc(m.name)}</span></div></td>
                ${cols.map((c) => cell(c, m)).join("")}
              </tr>`,
            )
            .join("")}</tbody>
        </table></div>`;
      refreshIcons();
    }

    $("#mode").addEventListener("click", (e) => {
      const b = e.target.closest("[data-mode]");
      if (b) ((mode = b.dataset.mode), draw());
    });
    $("#q").addEventListener("input", (e) => ((q = e.target.value), draw()));
    if ($("#dept")) $("#dept").addEventListener("change", (e) => ((dept = e.target.value), draw()));
    $("#table").addEventListener("change", async (e) => {
      const box = e.target.closest("[data-g]");
      if (!box) return;
      const k = key(box.dataset.g, box.dataset.m);
      const on = box.checked;
      const { error } = on
        ? await sb.from("gw_group_modules").insert({ group_id: box.dataset.g, module_id: box.dataset.m })
        : await sb.from("gw_group_modules").delete().eq("group_id", box.dataset.g).eq("module_id", box.dataset.m);
      if (error) {
        box.checked = !on;
        return setMsg(tm("saveFailed"));
      }
      on ? grants.add(k) : grants.delete(k);
    });
    // 个人例外：跟随群组 → 个人允许 → 个人禁止 → 跟随群组
    $("#table").addEventListener("click", async (e) => {
      const b = e.target.closest("[data-u]");
      if (!b || b.disabled) return;
      const u = b.dataset.u;
      const m = b.dataset.m;
      const k = key(u, m);
      const cur = overrides.get(k);
      const next = cur === undefined ? "allow" : cur === "allow" ? "deny" : undefined;
      b.disabled = true;
      const { error } =
        next === undefined
          ? await sb.from("gw_user_module_overrides").delete().eq("user_id", u).eq("module_id", m)
          : await sb.from("gw_user_module_overrides").upsert({ user_id: u, module_id: m, effect: next });
      if (error) return (b.disabled = false), setMsg(tm("saveFailed"));
      next ? overrides.set(k, next) : overrides.delete(k);
      const { data } = await sb.rpc("gw_admin_effective", { p_users: [u] });
      effective = new Set([...effective].filter((x) => !x.startsWith(u + ":")));
      (data || []).forEach((p) => effective.add(key(p.user_id, p.module_id)));
      draw();
    });
    draw();
  }

  // ================================================================ 群组（只限 super_admin）
  async function groupsTab() {
    const seq = routeSeq;
    const tg = (k, v) => t("admin.groups." + k, v);
    const [groups, departments, members, grantsRows] = await Promise.all([
      sb.from("gw_groups").select("*").order("sort_order").order("name"),
      loadDepartments(),
      sb.from("gw_group_members").select("group_id"),
      sb.from("gw_group_modules").select("group_id"),
    ]).then((r) => r.map((x) => (Array.isArray(x) ? x : x.data || [])));
    const count = (rows) => rows.reduce((acc, r) => ((acc[r.group_id] = (acc[r.group_id] || 0) + 1), acc), {});
    const memberCount = count(members);
    const moduleCount = count(grantsRows);
    const deptName = new Map(departments.map((d) => [d.id, d.name]));

    if (stale(seq)) return;
    view.innerHTML = `<div class="space-y-4">
      <div class="flex items-center justify-between gap-2">
        <p class="text-sm text-slate-500">${esc(tg("description"))}</p>
        <button id="add" class="${btn("primary")}">${icon("plus")} ${esc(tg("add"))}</button>
      </div>
      ${
        groups.length
          ? `<div class="${cls.card} divide-y divide-slate-200 dark:divide-slate-800">${groups
              .map(
                (g) => `<div class="flex flex-col gap-2 p-4 sm:flex-row sm:items-center">
                  <div class="min-w-0 flex-1">
                    <div class="flex flex-wrap items-center gap-2"><span class="font-medium">${esc(g.name)}</span>${badge(g.department_id ? deptName.get(g.department_id) : tg("companyWide"), g.department_id ? "blue" : "slate")}</div>
                    ${g.description ? `<p class="mt-0.5 text-sm text-slate-500">${esc(g.description)}</p>` : ""}
                    <p class="mt-0.5 text-xs text-slate-400">${esc(tg("counts", { members: memberCount[g.id] || 0, modules: moduleCount[g.id] || 0 }))}</p>
                  </div>
                  <div class="flex gap-1.5">
                    <button data-edit="${g.id}" class="${btn("ghost", "sm")}">${icon("pencil")} ${esc(tg("edit"))}</button>
                    <button data-del="${g.id}" class="${btn("ghost", "sm")} text-red-600 dark:text-red-400">${icon("trash-2")} ${esc(tg("delete"))}</button>
                  </div>
                </div>`,
              )
              .join("")}</div>`
          : empty(tg("empty"))
      }
    </div>`;

    function dialog(g) {
      const m = modal(
        g ? tg("editTitle") : tg("addTitle"),
        `<form class="space-y-4">
          <div data-err></div>
          ${field(tg("name"), `<input name="name" required value="${esc(g ? g.name : "")}" class="${cls.input}">`)}
          ${field(tg("descriptionLabel"), `<input name="description" value="${esc(g ? g.description || "" : "")}" class="${cls.input}">`)}
          ${field(tg("department"), select("department_id", [["", tg("companyWide")], ...departments.map((d) => [d.id, d.name])], g ? g.department_id : ""), tg("departmentHint"))}
          ${field(tg("sortOrder"), `<input name="sort_order" type="number" value="${g ? g.sort_order : 0}" class="${cls.input}">`)}
          <div class="flex justify-end gap-2">
            <button type="button" data-cancel class="${btn("secondary")}">${esc(tg("cancel"))}</button>
            <button type="submit" class="${btn("primary")}">${esc(tg("save"))}</button>
          </div>
        </form>`,
      );
      $("[data-cancel]", m.el).onclick = m.close;
      $("form", m.el).addEventListener("submit", async (e) => {
        e.preventDefault();
        const f = e.target;
        const row = { name: f.name.value.trim(), description: f.description.value.trim() || null, department_id: f.department_id.value || null, sort_order: Number(f.sort_order.value) || 0 };
        const { error } = g ? await sb.from("gw_groups").update(row).eq("id", g.id) : await sb.from("gw_groups").insert(row);
        if (error) return ($("[data-err]", m.el).innerHTML = alertBox(error.code === "23505" ? tg("duplicate") : tg("saveFailed")));
        m.close();
        groupsTab();
      });
    }

    $("#add").onclick = () => dialog(null);
    view.onclick = async (e) => {
      const b = e.target.closest("[data-edit],[data-del]");
      if (!b) return;
      const g = groups.find((x) => x.id === (b.dataset.edit || b.dataset.del));
      if (b.dataset.edit) return dialog(g);
      if (!(await confirmDialog(tg("deleteTitle"), tg("deleteBody", { name: g.name }), tg("delete"), tg("cancel")))) return;
      const { error } = await sb.from("gw_groups").delete().eq("id", g.id);
      if (error) setMsg(tg("saveFailed"));
      groupsTab();
    };
    refreshIcons();
  }

  // ================================================================ 部门（只限 super_admin）
  async function departmentsTab() {
    const seq = routeSeq;
    const td = (k, v) => t("admin.departments." + k, v);
    const departments = await loadDepartments();
    if (stale(seq)) return;
    view.innerHTML = `<div class="space-y-4">
      <div class="flex items-center justify-between gap-2">
        <p class="text-sm text-slate-500">${esc(td("description"))}</p>
        <button id="add" class="${btn("primary")}">${icon("plus")} ${esc(td("add"))}</button>
      </div>
      ${
        departments.length
          ? `<div class="${cls.card} divide-y divide-slate-200 dark:divide-slate-800">${departments
              .map(
                (d) => `<div class="flex items-center gap-3 p-4">
                  <span class="w-20 shrink-0 font-mono text-sm text-slate-500">${esc(d.code)}</span>
                  <span class="flex-1 font-medium">${esc(d.name)}</span>
                  <button data-edit="${d.id}" aria-label="${esc(td("edit"))}" class="${btn("ghost", "sm")}">${icon("pencil")}</button>
                  <button data-del="${d.id}" aria-label="${esc(td("delete"))}" class="${btn("ghost", "sm")} text-red-600 dark:text-red-400">${icon("trash-2")}</button>
                </div>`,
              )
              .join("")}</div>`
          : empty(td("empty"))
      }
    </div>`;

    function dialog(d) {
      const m = modal(
        d ? td("editTitle") : td("addTitle"),
        `<form class="space-y-4">
          <div data-err></div>
          ${field(td("code"), `<input name="code" required maxlength="32" value="${esc(d ? d.code : "")}" class="${cls.input} uppercase">`, td("codeHint"))}
          ${field(td("name"), `<input name="name" required value="${esc(d ? d.name : "")}" class="${cls.input}">`)}
          <div class="flex justify-end gap-2">
            <button type="button" data-cancel class="${btn("secondary")}">${esc(td("cancel"))}</button>
            <button type="submit" class="${btn("primary")}">${esc(td("save"))}</button>
          </div>
        </form>`,
      );
      $("[data-cancel]", m.el).onclick = m.close;
      $("form", m.el).addEventListener("submit", async (e) => {
        e.preventDefault();
        const row = { code: e.target.code.value.trim().toUpperCase(), name: e.target.name.value.trim() };
        const { error } = d ? await sb.from("gw_departments").update(row).eq("id", d.id) : await sb.from("gw_departments").insert(row);
        if (error) return ($("[data-err]", m.el).innerHTML = alertBox(error.code === "23505" ? td("duplicate") : error.code === "23514" ? td("badCode") : td("saveFailed")));
        m.close();
        departmentsTab();
      });
    }

    $("#add").onclick = () => dialog(null);
    view.onclick = async (e) => {
      const b = e.target.closest("[data-edit],[data-del]");
      if (!b) return;
      const d = departments.find((x) => x.id === (b.dataset.edit || b.dataset.del));
      if (b.dataset.edit) return dialog(d);
      if (!(await confirmDialog(td("deleteTitle"), td("deleteBody", { name: d.name }), td("delete"), td("cancel")))) return;
      const { error } = await sb.from("gw_departments").delete().eq("id", d.id);
      if (error) setMsg(td("saveFailed"));
      departmentsTab();
    };
    refreshIcons();
  }

  // ================================================================ 模块（只限 super_admin）
  async function modulesTab() {
    const seq = routeSeq;
    const tmod = (k, v) => t("admin.modules." + k, v);
    const [modules, departments, keyRes] = await Promise.all([
      sb.from("gw_modules").select("*").order("sort_order").order("name").then((r) => r.data || []),
      loadDepartments(),
      invoke("gw-admin", { action: "list_api_keys" }),
    ]);
    const keys = Object.fromEntries(((keyRes && keyRes.keys) || []).map((k) => [k.module_id, k.key_prefix]));
    const deptName = new Map(departments.map((d) => [d.id, d.name]));
    const functionsUrl = GW_CONFIG.supabaseUrl + "/functions/v1";

    if (stale(seq)) return;
    view.innerHTML = `<div class="space-y-4">
      <div class="flex items-center justify-between gap-2">
        <p class="text-sm text-slate-500">${esc(tmod("description"))}</p>
        <button id="add" class="${btn("primary")}">${icon("plus")} ${esc(tmod("add"))}</button>
      </div>
      ${
        modules.length
          ? `<div class="${cls.card} divide-y divide-slate-200 dark:divide-slate-800">${modules
              .map(
                (m) => `<div class="flex flex-col gap-3 p-4 md:flex-row md:items-center ${m.is_active ? "" : "opacity-60"}">
                  <span class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-700/20 dark:text-brand-100">${moduleIcon(m.icon, "size-5")}</span>
                  <div class="min-w-0 flex-1">
                    <div class="flex flex-wrap items-center gap-2">
                      <span class="font-medium">${esc(m.name)}</span>
                      <span class="font-mono text-xs text-slate-500">${esc(m.code)}</span>
                      ${badge(m.is_active ? tmod("active") : tmod("inactive"), m.is_active ? "green" : "slate")}
                      ${badge(tmod("levels." + m.access_level), "blue")}
                      ${m.department_id ? badge(deptName.get(m.department_id)) : ""}
                    </div>
                    <p class="mt-0.5 truncate text-sm text-slate-500">${esc(m.url)}</p>
                    ${m.access_level === 2 ? `<p class="mt-0.5 text-xs text-slate-400">${esc(keys[m.id] ? tmod("apiKeySet", { prefix: keys[m.id] }) : tmod("apiKeyMissing"))}</p>` : ""}
                  </div>
                  <div class="flex flex-wrap gap-1.5">
                    ${m.access_level === 2 ? `<button data-key="${m.id}" class="${btn("ghost", "sm")}">${icon("key-round")} ${esc(keys[m.id] ? tmod("rotateKey") : tmod("generateKey"))}</button>` : ""}
                    <button data-edit="${m.id}" class="${btn("ghost", "sm")}">${icon("pencil")} ${esc(tmod("edit"))}</button>
                    <button data-toggle="${m.id}" class="${btn("secondary", "sm")}">${esc(m.is_active ? tmod("deactivate") : tmod("activate"))}</button>
                  </div>
                </div>`,
              )
              .join("")}</div>`
          : empty(tmod("empty"))
      }
    </div>`;

    function dialog(mod) {
      const v = mod || { code: "", name: "", icon: "app-window", url: "https://", description: "", category: "", access_level: 1, is_active: true, open_mode: "new_tab", department_id: null, sort_order: 0 };
      let chosenIcon = v.icon;
      const m = modal(
        mod ? tmod("editTitle") : tmod("addTitle"),
        `<form class="space-y-4">
          <div data-err></div>
          <div class="grid gap-4 sm:grid-cols-2">
            ${field(tmod("code"), `<input name="code" required value="${esc(v.code)}" class="${cls.input} uppercase">`, tmod("codeHint"))}
            ${field(tmod("name"), `<input name="name" required value="${esc(v.name)}" class="${cls.input}">`)}
          </div>
          ${field(tmod("url"), `<input name="url" type="url" required value="${esc(v.url)}" class="${cls.input}">`)}
          ${field(tmod("descriptionLabel"), `<input name="description" maxlength="120" value="${esc(v.description || "")}" class="${cls.input}">`)}
          <div class="grid gap-4 sm:grid-cols-2">
            ${field(tmod("category"), `<input name="category" value="${esc(v.category || "")}" class="${cls.input}">`)}
            ${field(tmod("department"), select("department_id", [["", tmod("noDepartment")], ...departments.map((d) => [d.id, d.name])], v.department_id), tmod("departmentHint"))}
            ${field(tmod("accessLevel"), select("access_level", [1, 2, 3].map((l) => [l, tmod("levels." + l)]), v.access_level))}
            ${field(tmod("openMode"), select("open_mode", [["new_tab", tmod("newTab")], ["same_tab", tmod("sameTab")]], v.open_mode))}
            ${field(tmod("sortOrder"), `<input name="sort_order" type="number" value="${v.sort_order}" class="${cls.input}">`)}
            ${field(tmod("status"), select("is_active", [["1", tmod("active")], ["0", tmod("inactive")]], v.is_active ? "1" : "0"))}
          </div>
          <div>
            <p class="mb-1.5 ${cls.label}">${esc(tmod("icon"))}</p>
            <div class="flex flex-wrap gap-1.5">${Object.keys(GW.MODULE_ICONS).map((k) => `<button type="button" data-icon="${k}" title="${k}" class="flex size-9 items-center justify-center rounded-lg border">${moduleIcon(k, "size-4")}</button>`).join("")}</div>
          </div>
          <div class="flex justify-end gap-2">
            <button type="button" data-cancel class="${btn("secondary")}">${esc(tmod("cancel"))}</button>
            <button type="submit" class="${btn("primary")}">${esc(tmod("save"))}</button>
          </div>
        </form>`,
        { wide: true },
      );
      const paint = () =>
        $$("[data-icon]", m.el).forEach(
          (b) => (b.className = `flex size-9 items-center justify-center rounded-lg border ${b.dataset.icon === chosenIcon ? "border-brand-500 bg-brand-50 text-brand-600 dark:bg-brand-700/20 dark:text-brand-100" : "border-slate-200 text-slate-500 dark:border-slate-700"}`),
        );
      $$("[data-icon]", m.el).forEach((b) => b.addEventListener("click", () => ((chosenIcon = b.dataset.icon), paint())));
      paint();
      $("[data-cancel]", m.el).onclick = m.close;
      $("form", m.el).addEventListener("submit", async (e) => {
        e.preventDefault();
        const f = e.target;
        const err = (k) => ($("[data-err]", m.el).innerHTML = alertBox(tmod(k)));
        try {
          const u = new URL(f.url.value);
          if (!["https:", "http:"].includes(u.protocol)) throw new Error();
        } catch (x) {
          return err("badUrl");
        }
        const row = {
          code: f.code.value.trim().toUpperCase(),
          name: f.name.value.trim(),
          url: f.url.value.trim(),
          description: f.description.value.trim() || null,
          category: f.category.value.trim() || null,
          department_id: f.department_id.value || null,
          access_level: Number(f.access_level.value),
          open_mode: f.open_mode.value,
          sort_order: Number(f.sort_order.value) || 0,
          is_active: f.is_active.value === "1",
          icon: chosenIcon,
        };
        const { error } = mod ? await sb.from("gw_modules").update(row).eq("id", mod.id) : await sb.from("gw_modules").insert(row);
        if (error) return err(error.code === "23505" ? "duplicate" : error.code === "23514" ? "badCode" : "saveFailed");
        m.close();
        modulesTab();
      });
    }

    $("#add").onclick = () => dialog(null);
    view.onclick = async (e) => {
      const b = e.target.closest("[data-edit],[data-toggle],[data-key]");
      if (!b) return;
      const mod = modules.find((x) => x.id === (b.dataset.edit || b.dataset.toggle || b.dataset.key));
      if (b.dataset.edit) return dialog(mod);
      b.disabled = true;
      if (b.dataset.toggle) {
        const { error } = await sb.from("gw_modules").update({ is_active: !mod.is_active }).eq("id", mod.id);
        if (error) setMsg(tmod("saveFailed"));
        return modulesTab();
      }
      const r = await invoke("gw-admin", { action: "generate_api_key", module_id: mod.id });
      if (!r || !r.ok) return (b.disabled = false), setMsg(tmod("saveFailed"));
      const dlg = modal(
        tmod("apiKeyTitle", { name: mod.name }),
        `<div class="space-y-3 text-sm">
          <p class="text-slate-600 dark:text-slate-300">${esc(tmod("apiKeyBody"))}</p>
          <div class="rounded-lg bg-slate-100 p-3 font-mono break-all select-all dark:bg-slate-800" data-key-value>${esc(r.key)}</div>
          ${alertBox(tmod("apiKeyWarning"), "amber")}
          <div class="space-y-1 text-xs text-slate-500">
            <p>${esc(tmod("endpointIssue"))}: <code>${esc(functionsUrl)}/gw-issue-token</code></p>
            <p>${esc(tmod("endpointCheck"))}: <code>${esc(functionsUrl)}/gw-check-access</code></p>
            <p>${esc(tmod("endpointJwks"))}: <code>${esc(functionsUrl)}/gw-jwks</code></p>
          </div>
          <div class="flex justify-end"><button data-done class="${btn("primary")}">${esc(tmod("done"))}</button></div>
        </div>`,
        { wide: true, onClose: () => modulesTab() },
      );
      $("[data-done]", dlg.el).onclick = dlg.close;
    };
    refreshIcons();
  }

  // ================================================================ 公告
  async function announcementsTab() {
    const seq = routeSeq;
    const ta = (k, v) => t("admin.announcements." + k, v);
    const [announcements, departments] = await Promise.all([
      sb.from("gw_announcements").select("*").order("created_at", { ascending: false }).then((r) => r.data || []),
      loadDepartments(),
    ]);
    const deptName = new Map(departments.map((d) => [d.id, d.name]));
    const now = Date.now();
    const status = (a) =>
      !a.is_active ? badge(ta("off"))
      : new Date(a.starts_at).getTime() > now ? badge(ta("scheduled"), "amber")
      : a.ends_at && new Date(a.ends_at).getTime() <= now ? badge(ta("ended"))
      : badge(ta("live"), "green");
    // datetime-local 使用浏览器时区
    const toLocalInput = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

    if (stale(seq)) return;
    view.innerHTML = `<div class="space-y-4">
      <div class="flex items-center justify-between gap-2">
        <p class="text-sm text-slate-500">${esc(isSuper ? ta("descriptionSuper") : ta("descriptionAdmin"))}</p>
        <button id="add" class="${btn("primary")}">${icon("plus")} ${esc(ta("add"))}</button>
      </div>
      ${
        announcements.length
          ? `<div class="${cls.card} divide-y divide-slate-200 dark:divide-slate-800">${announcements
              .map(
                (a) => `<div class="flex flex-col gap-2 p-4 sm:flex-row sm:items-center">
                  <div class="min-w-0 flex-1">
                    <div class="mb-1 flex flex-wrap items-center gap-2">${status(a)}${badge(ta("levels." + a.level), a.level === "warning" ? "amber" : "blue")}${badge(a.department_id ? deptName.get(a.department_id) : ta("allCompany"))}</div>
                    <p class="text-sm whitespace-pre-line">${esc(a.message)}</p>
                    <p class="mt-1 text-xs text-slate-400">${esc(fmtDateTime(a.starts_at))} → ${esc(a.ends_at ? fmtDateTime(a.ends_at) : ta("noEnd"))}</p>
                  </div>
                  <div class="flex gap-1.5">
                    <button data-toggle="${a.id}" class="${btn("secondary", "sm")}">${esc(a.is_active ? ta("turnOff") : ta("turnOn"))}</button>
                    <button data-del="${a.id}" aria-label="${esc(ta("delete"))}" class="${btn("ghost", "sm")} text-red-600 dark:text-red-400">${icon("trash-2")}</button>
                  </div>
                </div>`,
              )
              .join("")}</div>`
          : empty(ta("empty"))
      }
    </div>`;

    $("#add").onclick = () => {
      const m = modal(
        ta("addTitle"),
        `<form class="space-y-4">
          <div data-err></div>
          ${field(ta("message"), `<textarea name="message" required maxlength="500" rows="3" class="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500 dark:border-slate-700 dark:bg-slate-900"></textarea>`)}
          <div class="grid gap-4 sm:grid-cols-2">
            ${field(ta("level"), select("level", [["info", ta("levels.info")], ["warning", ta("levels.warning")]], "info"))}
            ${field(
              ta("audience"),
              select(
                "department_id",
                [...(isSuper ? [["", ta("allCompany")]] : []), ...departments.filter((d) => isSuper || d.id === me.department_id).map((d) => [d.id, d.name])],
                isSuper ? "" : me.department_id,
                isSuper ? "" : "disabled",
              ),
            )}
            ${field(ta("startsAt"), `<input name="starts_at" type="datetime-local" required value="${toLocalInput(new Date())}" class="${cls.input}">`)}
            ${field(ta("endsAt"), `<input name="ends_at" type="datetime-local" class="${cls.input}">`)}
          </div>
          <div class="flex justify-end gap-2">
            <button type="button" data-cancel class="${btn("secondary")}">${esc(ta("cancel"))}</button>
            <button type="submit" class="${btn("primary")}">${esc(ta("publish"))}</button>
          </div>
        </form>`,
      );
      $("[data-cancel]", m.el).onclick = m.close;
      $("form", m.el).addEventListener("submit", async (e) => {
        e.preventDefault();
        const f = e.target;
        const { error } = await sb.from("gw_announcements").insert({
          message: f.message.value.trim(),
          level: f.level.value,
          department_id: (isSuper ? f.department_id.value : me.department_id) || null,
          starts_at: new Date(f.starts_at.value).toISOString(),
          ends_at: f.ends_at.value ? new Date(f.ends_at.value).toISOString() : null,
          created_by: me.id,
        });
        if (error) return ($("[data-err]", m.el).innerHTML = alertBox(ta("saveFailed")));
        m.close();
        announcementsTab();
      });
    };
    view.onclick = async (e) => {
      const b = e.target.closest("[data-toggle],[data-del]");
      if (!b) return;
      const a = announcements.find((x) => x.id === (b.dataset.toggle || b.dataset.del));
      if (b.dataset.toggle) await sb.from("gw_announcements").update({ is_active: !a.is_active }).eq("id", a.id);
      else await sb.from("gw_announcements").delete().eq("id", a.id);
      announcementsTab();
    };
    refreshIcons();
  }

  // ================================================================ 操作记录
  async function auditTab() {
    const seq = routeSeq;
    const tl = (k, v) => t("admin.audit." + k, v);
    const PAGE = 50;
    const TARGETS = ["auth", "profiles", "groups", "group_members", "modules", "group_modules", "user_module_overrides", "departments", "announcements"];
    let filters = { from: "", to: "", actor: "", action: "", target: "" };
    let page = 1;

    // 依筛选条件查询（以当前用户身份，RLS 决定看得到哪些）
    function query() {
      let q = sb.from("gw_audit_logs").select("*", { count: "exact" }).order("created_at", { ascending: false });
      if (filters.from) q = q.gte("created_at", new Date(filters.from + "T00:00:00").toISOString());
      if (filters.to) q = q.lt("created_at", new Date(new Date(filters.to + "T00:00:00").getTime() + 86400000).toISOString());
      if (filters.action) q = q.ilike("action", filters.action + "%");
      if (filters.actor) q = q.ilike("actor_email", "%" + filters.actor + "%");
      if (filters.target) q = q.eq("target_type", filters.target);
      return q;
    }
    const targetLabel = (x) => (TARGETS.includes(x) ? tl("targets." + x) : x);

    if (stale(seq)) return;
    view.innerHTML = `<div class="space-y-4">
      <form id="filters" class="grid grid-cols-2 gap-2 lg:grid-cols-[repeat(5,minmax(0,1fr))_auto_auto]">
        <input type="date" name="from" title="${esc(tl("from"))}" aria-label="${esc(tl("from"))}" class="${cls.input}">
        <input type="date" name="to" title="${esc(tl("to"))}" aria-label="${esc(tl("to"))}" class="${cls.input}">
        <input name="actor" placeholder="${esc(tl("actor"))}" class="${cls.input}">
        <input name="action" placeholder="${esc(tl("action"))}" class="${cls.input}">
        <select name="target" class="${cls.input} col-span-2 lg:col-span-1"><option value="">${esc(tl("allTargets"))}</option>${TARGETS.map((x) => `<option value="${x}">${esc(tl("targets." + x))}</option>`).join("")}</select>
        <button type="submit" class="${btn("primary")}">${esc(tl("filter"))}</button>
        <button type="button" id="export" class="${btn("secondary")}">${icon("download")} ${esc(tl("export"))}</button>
      </form>
      <div id="rows">${GW.spinner()}</div>
    </div>`;

    function diff(before, after) {
      const keys = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])].filter(
        (k) => k !== "updated_at" && k !== "created_at" && JSON.stringify((before || {})[k]) !== JSON.stringify((after || {})[k]),
      );
      if (!keys.length) return `<p class="mt-2 text-xs text-slate-400">${esc(tl("noDetails"))}</p>`;
      const show = (v) => (v === undefined ? "—" : JSON.stringify(v));
      return `<div class="mt-2 overflow-x-auto"><table class="text-xs">
        <thead><tr class="text-left text-slate-500"><th class="pr-4 font-medium">${esc(tl("field"))}</th><th class="pr-4 font-medium">${esc(tl("before"))}</th><th class="font-medium">${esc(tl("after"))}</th></tr></thead>
        <tbody class="font-mono">${keys.map((k) => `<tr><td class="pr-4 text-slate-500">${esc(k)}</td><td class="pr-4 text-red-600 dark:text-red-400">${esc(show((before || {})[k]))}</td><td class="text-emerald-700 dark:text-emerald-400">${esc(show((after || {})[k]))}</td></tr>`).join("")}</tbody>
      </table></div>`;
    }

    async function load() {
      const { data, count } = await query().range((page - 1) * PAGE, page * PAGE - 1);
      if (stale(seq) || !$("#rows")) return;
      const rows = data || [];
      const pages = Math.max(1, Math.ceil((count || 0) / PAGE));
      $("#rows").innerHTML = `<p class="mb-4 text-sm text-slate-500">${esc(tl("total", { count: count || 0 }))}</p>
        ${
          rows.length
            ? `<div class="${cls.card} divide-y divide-slate-200 dark:divide-slate-800">${rows
                .map(
                  (r) => `<details class="p-3 text-sm">
                    <summary class="flex cursor-pointer list-none flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
                      <span class="w-40 shrink-0 text-xs text-slate-500 tabular-nums">${esc(fmtDateTime(r.created_at, { dateStyle: "short", timeStyle: "medium" }))}</span>
                      <span class="w-48 shrink-0 truncate">${esc(r.actor_email || tl("system"))}</span>
                      <span class="flex flex-1 flex-wrap items-center gap-1.5">${badge(r.action, "blue")}${badge(targetLabel(r.target_type))}<span class="truncate text-slate-600 dark:text-slate-300">${esc(r.target_label || "")}</span></span>
                    </summary>
                    ${diff(r.before_data, r.after_data)}
                  </details>`,
                )
                .join("")}</div>`
            : empty(tl("empty"))
        }
        ${
          pages > 1
            ? `<div class="mt-4 flex items-center justify-center gap-2 text-sm">
                ${page > 1 ? `<button data-page="${page - 1}" class="${btn("secondary", "sm")}">${esc(tl("prev"))}</button>` : ""}
                <span class="text-slate-500">${esc(tl("page", { page, pages }))}</span>
                ${page < pages ? `<button data-page="${page + 1}" class="${btn("secondary", "sm")}">${esc(tl("next"))}</button>` : ""}
              </div>`
            : ""
        }`;
    }

    $("#filters").addEventListener("submit", (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      filters = Object.fromEntries(Object.keys(filters).map((k) => [k, String(f.get(k) || "").trim()]));
      page = 1;
      load();
    });
    $("#rows").addEventListener("click", (e) => {
      const b = e.target.closest("[data-page]");
      if (b) ((page = Number(b.dataset.page)), load());
    });
    $("#export").addEventListener("click", async (e) => {
      e.target.disabled = true;
      const rows = [];
      for (let offset = 0; offset < 10000; offset += 1000) {
        const { data } = await query().range(offset, offset + 999);
        rows.push(...(data || []));
        if (!data || data.length < 1000) break;
      }
      await GW.downloadXlsx(`gateway-audit-${new Date().toISOString().slice(0, 10)}.xlsx`, (wb) => {
        const sheet = wb.addWorksheet("audit");
        sheet.columns = [
          { header: tl("time"), key: "time", width: 22 },
          { header: tl("actor"), key: "actor", width: 28 },
          { header: tl("action"), key: "action", width: 24 },
          { header: tl("target"), key: "target", width: 22 },
          { header: tl("targetLabel"), key: "label", width: 28 },
          { header: tl("before"), key: "before", width: 50 },
          { header: tl("after"), key: "after", width: 50 },
        ];
        sheet.getRow(1).font = { bold: true };
        rows.forEach((r) =>
          sheet.addRow({
            time: new Date(r.created_at),
            actor: r.actor_email || tl("system"),
            action: r.action,
            target: r.target_type,
            label: r.target_label || r.target_id || "",
            before: r.before_data ? JSON.stringify(r.before_data) : "",
            after: r.after_data ? JSON.stringify(r.after_data) : "",
          }),
        );
        sheet.getColumn("time").numFmt = "yyyy-mm-dd hh:mm:ss";
      });
      e.target.disabled = false;
    });
    refreshIcons();
    load();
  }

  // ================================================================ 以此人身份预览（只读）
  async function previewTab(userId) {
    const seq = routeSeq;
    const tp = (k, v) => t("admin.preview." + k, v);
    // 权限检查在 gw_get_home 里：只能预览自己可查看的用户
    const { data, error } = await sb.rpc("gw_get_home", { p_user: userId });
    if (stale(seq)) return;
    if (error || !data) return (view.innerHTML = empty(tp("notAllowed")));
    if (stale(seq)) return;
    view.innerHTML = `<div class="space-y-4">
      <div class="flex flex-col gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 sm:flex-row sm:items-center dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
        ${icon("eye", "size-4 shrink-0")}
        <span class="flex-1">${esc(tp("banner", { name: data.profile.full_name, email: data.profile.email }))}${data.profile.department ? " · " + esc(data.profile.department) : ""}</span>
        <a href="#users" class="font-medium underline">${esc(tp("back"))}</a>
      </div>
      <div id="board"></div>
    </div>`;
    refreshIcons();
    GWHome.render($("#board"), data, { readOnly: true });
  }

  // ---------------------------------------------------------------- 分页切换（#users、#matrix、#preview=id …）
  const HANDLERS = { users: usersTab, matrix: matrixTab, groups: groupsTab, modules: modulesTab, departments: departmentsTab, announcements: announcementsTab, audit: auditTab };
  async function route() {
    const hash = location.hash.slice(1) || "users";
    const [name, arg] = hash.split("=");
    const active = name === "preview" ? "users" : HANDLERS[name] && TABS.some(([k]) => k === name) ? name : "users";
    $("#tabs").innerHTML = TABS.map(
      ([k, label]) => `<a href="#${k}" class="-mb-px border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap ${
        k === active ? "border-brand-600 text-brand-700 dark:text-brand-100" : "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
      }">${esc(label)}</a>`,
    ).join("");
    routeSeq++;
    if (name !== "preview") setMsg("");
    view.onclick = null;
    view.innerHTML = GW.spinner();
    if (name === "preview" && arg) return previewTab(arg);
    await HANDLERS[active]();
  }
  window.addEventListener("hashchange", route);
  route();
})();
