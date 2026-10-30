/* ================================================================
   MJM Gateway — 权限后台
   分页：用户、权限矩阵、群组、模块、部门、公告、操作记录、预览（#preview=用户id）
   读写都以当前用户身份直接连 Supabase，RLS 决定能看、能改什么；
   需要 service_role 的动作（建立用户、重设密码、停用、API Key）走 gw-admin Edge Function。
   ================================================================ */
(async function () {
  const { sb, t, esc, $, $$, icon, moduleIcon, cls, btn, badge, alertBox, modal, confirmDialog, toast, invoke, refreshIcons, fmtDateTime } = GW;
  const me = await GW.requireProfile("manage");
  if (!me) return;
  const isSuper = me.role === "super_admin";
  const main = GW.shell(me, "admin");

  /* 设置页（右上角齿轮进来）：
     super_admin → 两个大按钮：User & Group Manage（全部用户 / 群组列表 / 模块权限）、
                   Master Manage（角色、Business、Company、模块、公告、操作记录）
     自订角色    → 群组列表（自己管的 Business）、模块权限、公告（角色可发公告时）
     模块管理员  → 模块权限（自己管理的模块） */
  const SECTIONS = isSuper
    ? [
        ["userGroup", "users-round", ["users", "groups", "access"]],
        ["master", "database", ["roles", "business", "company", "modules", "announcements", "audit"]],
      ]
    : [
        [
          "userGroup",
          "users-round",
          [...(me.businessIds.length ? ["groups"] : []), "access", ...(me.canPost ? ["announcements"] : [])],
        ],
      ];
  const TABS = SECTIONS.flatMap(([, , tabs]) => tabs);

  main.innerHTML = `<div class="space-y-5">
    <div class="relative flex min-h-10 flex-col items-center gap-2 sm:flex-row sm:justify-center">
      <a href="index.html" class="inline-flex self-start sm:absolute sm:left-0 sm:self-auto items-center gap-1 text-sm text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">${icon("arrow-left")} ${esc(t("admin.backToPortal"))}</a>
      <h1 class="text-xl font-semibold sm:text-2xl">${esc(t("admin.pageTitle"))}</h1>
    </div>
    <div id="sections" class="grid gap-2 sm:flex sm:justify-center"></div>
    <div class="-mx-4 overflow-x-auto px-4 sm:text-center">
      <nav id="tabs" class="inline-flex min-w-max gap-1 rounded-xl bg-slate-200/70 p-1 dark:bg-slate-800"></nav>
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

  // ---------------------------------------------------------------- 模块权限：Admin / Access 两个勾（共用）
  /* 每个模块对每个人有两个勾：
     Access = 可以用这个模块；Admin = 这个模块的管理员（勾 Admin 一定同时有 Access）。
     谁可以勾（真正的检查在数据库 RLS）：
       Access：super_admin；角色设定里有这个模块（对方在那个 Business）；这个模块的管理员（对方和自己在同一个有这个模块的 Business）
       Admin：super_admin；角色设定里有这个模块
     不能改自己，也不能改 super_admin。 */
  async function loadAccess() {
    const [groups, members, gm, mods, rows, mine, users, coTags, companies] = await Promise.all([
      sb.from("gw_groups").select("id, name").order("sort_order").order("name"),
      sb.from("gw_group_members").select("group_id, user_id"),
      sb.from("gw_group_modules").select("group_id, module_id"),
      sb.from("gw_modules").select("id, code, name, icon, is_active").order("sort_order").order("name"),
      sb.from("gw_module_members").select("user_id, module_id, is_admin"),
      isSuper || !me.role_id ? Promise.resolve({ data: [] }) : sb.from("gw_role_modules").select("group_id, module_id").eq("role_id", me.role_id),
      sb.from("gw_profiles").select("id, full_name, email, role, status").order("full_name"),
      sb.from("gw_module_companies").select("module_id, company_id"),
      sb.from("gw_companies").select("id, code, name"),
    ]).then((r) => r.map((x) => x.data || []));
    const coName = new Map(companies.map((c) => [c.id, c.code || c.name]));
    const ctx = { groups, members, gm, mods, users, mine, rows: new Map(rows.map((r) => [r.user_id + ":" + r.module_id, r])) };
    const inGroup = (uid, gid) => members.some((m) => m.user_id === uid && m.group_id === gid);
    const groupHas = (gid, mid) => gm.some((x) => x.group_id === gid && x.module_id === mid);
    const myAdmin = (mid) => !!(ctx.rows.get(me.id + ":" + mid) || {}).is_admin;
    const roleHas = (gid, mid) => mine.some((x) => x.group_id === gid && x.module_id === mid);
    const locked = (u) => u.id === me.id || u.role === "super_admin";
    // 在某个 Business 里，我能不能改这个人这个模块的 Access / Admin
    ctx.canAccess = (u, gid, mid) => !locked(u) && (isSuper || roleHas(gid, mid) || (myAdmin(mid) && inGroup(me.id, gid) && groupHas(gid, mid)));
    ctx.canAdmin = (u, gid, mid) => !locked(u) && (isSuper || roleHas(gid, mid));
    ctx.inGroup = inGroup;
    ctx.companyTags = (mid) => coTags.filter((x) => x.module_id === mid).map((x) => coName.get(x.company_id)).filter(Boolean);
    ctx.groupHas = groupHas;
    // 我管得到的 (Business, 模块) 组合
    ctx.managedPairs = gm.filter((x) => isSuper || roleHas(x.group_id, x.module_id) || (myAdmin(x.module_id) && inGroup(me.id, x.group_id)));
    return ctx;
  }

  // 改 Access / Admin；回传 null 表示失败
  async function saveAccess(ctx, uid, mid, access, admin) {
    const key = uid + ":" + mid;
    const row = ctx.rows.get(key);
    let error;
    if (!access) {
      if (row) ({ error } = await sb.from("gw_module_members").delete().eq("user_id", uid).eq("module_id", mid));
      if (!error) ctx.rows.delete(key);
    } else if (!row) {
      ({ error } = await sb.from("gw_module_members").insert({ user_id: uid, module_id: mid, is_admin: !!admin }));
      if (!error) ctx.rows.set(key, { user_id: uid, module_id: mid, is_admin: !!admin });
    } else if (!!row.is_admin !== !!admin) {
      ({ error } = await sb.from("gw_module_members").update({ is_admin: !!admin }).eq("user_id", uid).eq("module_id", mid));
      if (!error) row.is_admin = !!admin;
    }
    if (error) toast(t("admin.users.accessDialog.saveFailed"));
    return !error;
  }

  const tick = (attrs, on, enabled, label) =>
    `<label class="inline-flex items-center gap-1.5 text-xs font-medium ${enabled ? "cursor-pointer" : "cursor-not-allowed opacity-40"}">
      <input type="checkbox" ${attrs} ${on ? "checked" : ""} ${enabled ? "" : "disabled"} class="size-4 accent-emerald-600">${esc(label)}
    </label>`;

  // 勾选事件（两个画面共用）：勾 Admin → Access 一定勾上；取消 Access → Admin 也取消
  async function onTick(ctx, e, redraw) {
    const box = e.target.closest("input[data-acc]");
    if (!box) return;
    const [uid, mid, kind] = box.dataset.acc.split(":");
    const row = ctx.rows.get(uid + ":" + mid);
    let access = !!row;
    let admin = !!(row && row.is_admin);
    if (kind === "admin") ((admin = box.checked), admin && (access = true));
    else ((access = box.checked), !access && (admin = false));
    box.disabled = true;
    await saveAccess(ctx, uid, mid, access, admin);
    redraw();
  }

  // 某个人的模块权限（用户名单、群组列表点进来）；onlyGroup：只列某一个 Business
  async function moduleAccessDialog(user, onlyGroup) {
    const ta = (k, v) => t("admin.users.accessDialog." + k, v);
    const m = modal(ta("title", { name: user.full_name }), GW.spinner(), { wide: true });
    const ctx = await loadAccess();
    const modById = new Map(ctx.mods.map((x) => [x.id, x]));
    const sections = ctx.groups
      .filter((g) => ctx.inGroup(user.id, g.id) && (!onlyGroup || g.id === onlyGroup))
      .map((g) => [g, ctx.gm.filter((x) => x.group_id === g.id && modById.has(x.module_id)).map((x) => modById.get(x.module_id))])
      .filter(([, list]) => list.length);

    function draw() {
      m.el.innerHTML = `<div class="space-y-4">
        <p class="text-sm text-slate-500">${esc(ta("hint"))}</p>
        ${
          sections.length
            ? sections
                .map(
                  ([g, list]) => `<div>
                    <p class="mb-1.5 flex items-center gap-1.5 text-xs font-bold tracking-wider text-slate-500 uppercase">${icon("briefcase-business", "size-3.5")}${esc(g.name)}</p>
                    <div class="divide-y divide-slate-200 rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-800">${list
                      .map((mod) => {
                        const row = ctx.rows.get(user.id + ":" + mod.id);
                        return `<div class="flex flex-wrap items-center gap-3 p-3 ${mod.is_active ? "" : "opacity-50"}">
                          <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-700/20 dark:text-brand-100">${moduleIcon(mod.icon, "size-4")}</span>
                          <span class="min-w-0 flex-1 truncate text-sm font-medium">${esc(mod.name)}</span>
                          <span class="flex gap-4">
                            ${tick(`data-acc="${user.id}:${mod.id}:admin"`, row && row.is_admin, ctx.canAdmin(user, g.id, mod.id), ta("admin"))}
                            ${tick(`data-acc="${user.id}:${mod.id}:access"`, !!row, ctx.canAccess(user, g.id, mod.id) && !(row && row.is_admin && !ctx.canAdmin(user, g.id, mod.id)), ta("access"))}
                          </span>
                        </div>`;
                      })
                      .join("")}</div>
                  </div>`,
                )
                .join("")
            : empty(ta(ctx.groups.some((g) => ctx.inGroup(user.id, g.id)) ? "noModules" : "noBusiness"))
        }
        <div class="flex justify-end"><button data-done class="${btn("primary")}">${esc(t("admin.users.done"))}</button></div>
      </div>`;
      refreshIcons();
    }
    m.el.addEventListener("change", (e) => onTick(ctx, e, draw));
    m.el.addEventListener("click", (e) => e.target.closest("[data-done]") && m.close());
    draw();
  }

  // ================================================================ 模块权限（每个模块：谁是 Admin、谁有 Access）
  async function accessTab() {
    const seq = routeSeq;
    const ta = (k, v) => t("admin.access." + k, v);
    const tad = (k) => t("admin.users.accessDialog." + k);
    const ctx = await loadAccess();
    if (stale(seq)) return;
    const userById = new Map(ctx.users.map((u) => [u.id, u]));
    let query = "";
    // 模块 → 我管得到的 Business
    const byModule = ctx.mods
      .map((mod) => [mod, ctx.groups.filter((g) => ctx.managedPairs.some((p) => p.group_id === g.id && p.module_id === mod.id))])
      .filter(([, gs]) => gs.length);

    function draw() {
      const q = query.trim().toLowerCase();
      view.innerHTML = `<div class="space-y-4">
        <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
          <p class="flex-1 text-sm text-slate-500">${esc(ta("description"))}</p>
          <input id="acc-q" type="search" value="${esc(query)}" placeholder="${esc(t("admin.users.search"))}" class="${cls.input} h-9 sm:w-64">
        </div>
        ${
          byModule.length
            ? byModule
                .map(
                  ([mod, gs]) => `<div class="${cls.card} p-4">
                    <div class="mb-3 flex items-center gap-2">
                      <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-700/20 dark:text-brand-100">${moduleIcon(mod.icon, "size-4")}</span>
                      <span class="font-semibold">${esc(mod.name)}</span>
                      ${ctx.companyTags(mod.id).map((c) => badge(c)).join("")}
                      <span class="text-xs text-slate-400">${esc(ta("counts", { access: ctx.users.filter((u) => ctx.rows.has(u.id + ":" + mod.id)).length, admins: ctx.users.filter((u) => (ctx.rows.get(u.id + ":" + mod.id) || {}).is_admin).length }))}</span>
                    </div>
                    <div class="space-y-3">${gs
                      .map((g) => {
                        const people = ctx.members
                          .filter((x) => x.group_id === g.id)
                          .map((x) => userById.get(x.user_id))
                          .filter((u) => u && (!q || (u.full_name + " " + u.email).toLowerCase().includes(q)));
                        return `<div>
                          <p class="mb-1 flex items-center gap-1.5 text-xs font-bold tracking-wider text-slate-500 uppercase">${icon("briefcase-business", "size-3.5")}${esc(g.name)}</p>
                          ${
                            people.length
                              ? `<div class="divide-y divide-slate-100 rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-800">${people
                                  .map((u) => {
                                    const row = ctx.rows.get(u.id + ":" + mod.id);
                                    return `<div data-person="${u.id}" class="flex flex-wrap items-center gap-3 px-3 py-2">
                                      <span class="min-w-0 flex-1"><span class="block truncate text-sm font-medium">${esc(u.email)}</span><span class="block truncate text-xs text-slate-500">${esc(u.full_name)}</span></span>
                                      <span class="flex gap-4">
                                        ${tick(`data-acc="${u.id}:${mod.id}:admin"`, row && row.is_admin, ctx.canAdmin(u, g.id, mod.id), tad("admin"))}
                                        ${tick(`data-acc="${u.id}:${mod.id}:access"`, !!row, ctx.canAccess(u, g.id, mod.id) && !(row && row.is_admin && !ctx.canAdmin(u, g.id, mod.id)), tad("access"))}
                                      </span>
                                    </div>`;
                                  })
                                  .join("")}</div>`
                              : `<p class="rounded-xl border border-dashed border-slate-200 py-3 text-center text-xs text-slate-400 dark:border-slate-700">${esc(ta(q ? "noMatch" : "noPeople"))}</p>`
                          }
                        </div>`;
                      })
                      .join("")}</div>
                  </div>`,
                )
                .join("")
            : empty(ta("empty"))
        }
      </div>`;
      refreshIcons();
      $("#acc-q").addEventListener("input", (e) => {
        query = e.target.value;
        const pos = e.target.selectionStart;
        draw();
        const input = $("#acc-q");
        input.focus();
        input.setSelectionRange(pos, pos);
      });
    }
    view.onchange = (e) => onTick(ctx, e, draw);
    draw();
  }

  // ================================================================ 全部用户（只限 super_admin）
  async function usersTab() {
    const seq = routeSeq;
    const tu = (k, v) => t("admin.users." + k, v);
    const [users, groups, members, roles] = await Promise.all([
      sb.from("gw_profiles").select("*").order("created_at", { ascending: false }),
      sb.from("gw_groups").select("*").order("sort_order").order("name"),
      sb.from("gw_group_members").select("group_id, user_id"),
      sb.from("gw_roles").select("id, name").order("sort_order").order("name"),
    ]).then((r) => r.map((x) => x.data || []));
    const groupName = new Map(groups.map((g) => [g.id, g.name]));
    const roleName = new Map(roles.map((r) => [r.id, r.name]));
    const groupsOf = (id) => members.filter((m) => m.user_id === id).map((m) => m.group_id);
    // 角色下拉：一般用户 / 各自订角色 / Super Admin（值 = "user" | 角色 id | "super_admin"）
    const roleValue = (u) => (u.role === "super_admin" ? "super_admin" : u.role_id || "user");
    const roleBadge = (u) => (u.role === "super_admin" ? badge(tu("roles.super_admin"), "red") : u.role_id ? badge(roleName.get(u.role_id) || tu("roles.user"), "amber") : badge(tu("roles.user")));
    const roleOptions = [["user", tu("roles.user")], ...roles.map((r) => [r.id, r.name]), ["super_admin", tu("roles.super_admin")]];
    const toRole = (v) => (v === "super_admin" ? { role: "super_admin", role_id: null } : v === "user" ? { role: "user", role_id: null } : { role: "user", role_id: v });
    const filter = { q: "", role: "", status: "" };

    if (stale(seq)) return;
    view.innerHTML = `<div class="space-y-4">
      <div class="flex flex-col gap-2 lg:flex-row">
        ${searchBox("q", tu("search"))}
        <div class="grid grid-cols-2 gap-2 lg:flex">
          <select id="role-filter" class="${cls.input} lg:w-40"><option value="">${esc(tu("allRoles"))}</option>${roleOptions.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("")}</select>
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
          (!filter.role || roleValue(u) === filter.role) &&
          (!filter.status || u.status === filter.status),
      );
      $("#list").innerHTML = list.length
        ? `<div class="${cls.card} divide-y divide-slate-200 dark:divide-slate-800">${list
            .map(
              (u) => `<div class="flex flex-col gap-3 p-4 md:flex-row md:items-center">
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="font-medium">${esc(u.full_name)}</span>
                    ${roleBadge(u)}
                    ${u.status === "disabled" ? badge(tu("status.disabled"), "red") : ""}
                    ${u.must_change_password ? badge(tu("mustChange")) : ""}
                  </div>
                  <div class="mt-0.5 truncate text-sm text-slate-500">${esc(u.email)}</div>
                  ${groupsOf(u.id).length ? `<div class="mt-1 flex flex-wrap gap-1">${groupsOf(u.id).map((g) => badge(groupName.get(g), "blue")).join("")}</div>` : ""}
                </div>
                <div class="flex flex-wrap gap-1.5">
                  <a href="#preview=${u.id}" class="${btn("ghost", "sm")}">${icon("eye")} ${esc(tu("preview"))}</a>
                  ${u.role !== "super_admin" ? `<button data-access="${u.id}" class="${btn("secondary", "sm")}">${icon("layout-grid")} ${esc(tu("access"))}</button>` : ""}
                  <button data-edit="${u.id}" class="${btn("ghost", "sm")}">${icon("pencil")} ${esc(tu("edit"))}</button>
                  <button data-reset="${u.id}" class="${btn("ghost", "sm")}">${icon("key-round")} ${esc(tu("resetPassword"))}</button>
                  ${
                    u.id !== me.id
                      ? `<button data-status="${u.id}" class="${btn(u.status === "active" ? "ghost" : "secondary", "sm")} ${u.status === "active" ? "text-red-600 dark:text-red-400" : ""}">${esc(u.status === "active" ? tu("disable") : tu("enable"))}</button>`
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
      const selected = new Set(user ? groupsOf(user.id) : []);
      const m = modal(
        user ? tu("editTitle") : tu("addTitle"),
        `<form class="space-y-4">
          <div data-err></div>
          ${field("Email", `<input name="email" type="email" required value="${esc(user ? user.email : "")}" ${user ? "disabled" : ""} class="${cls.input}">`)}
          ${field(tu("name"), `<input name="full_name" required value="${esc(user ? user.full_name : "")}" class="${cls.input}">`)}
          ${field(tu("role"), select("role", roleOptions, user ? roleValue(user) : "user", user && user.id === me.id ? "disabled" : ""), tu("roleHint"))}
          <div>
            <p class="mb-1.5 ${cls.label}">${esc(tu("groups"))}</p>
            ${
              groups.length
                ? `<div class="flex flex-wrap gap-2">${groups.map((g) => `<button type="button" data-group="${g.id}" class="rounded-full border px-3 py-1 text-sm">${esc(g.name)}</button>`).join("")}</div>`
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
        const input = { full_name: f.full_name.value.trim(), ...toRole(f.role.disabled ? roleValue(user) : f.role.value), group_ids: [...selected] };
        const r = user ? await updateUser(user.id, input) : await invoke("gw-admin", { action: "create_user", user: { ...input, email: f.email.value.trim() } });
        submit.disabled = false;
        if (!r || !r.ok) return ($("[data-err]", m.el).innerHTML = alertBox(tu("errors." + ((r && r.error) || "forbidden"))));
        m.close();
        if (r.password) showSecret(tu("tempPasswordTitle"), tu("tempPasswordBody", { email: r.email }), r.password, tu("tempPasswordWarning"));
        else setMsg(user ? tu("savedOk") : r.linked ? tu("linkedOk") : tu("createdOk"), "green");
        usersTab();
      });
    }

    // 编辑用户：直接以 super_admin 身份写入，RLS 与 gw_profiles_guard 检查权限
    async function updateUser(id, input) {
      const { data: cur } = await sb.from("gw_profiles").select("full_name, role, role_id").eq("id", id).single();
      if (!cur) return { ok: false, error: "forbidden" };
      const patch = {};
      if (input.full_name && input.full_name !== cur.full_name) patch.full_name = input.full_name;
      if (input.role !== cur.role) patch.role = input.role;
      if (input.role_id !== cur.role_id) patch.role_id = input.role_id;
      if (Object.keys(patch).length) {
        const { data, error } = await sb.from("gw_profiles").update(patch).eq("id", id).select("id");
        if (error || !data || !data.length) return { ok: false, error: "forbidden" };
      }
      const before = new Set(groupsOf(id));
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
            { header: ti("colGroups"), width: 30 },
            { header: ti("colRole"), width: 16 },
          ];
          sheet.addRow(["someone@example.com", "Ahmad bin Ali", "Plantation, Fleet", "user"]);
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
            .map(([email, full_name, groupsCell, role]) => ({
              email,
              full_name,
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
    $("#role-filter").addEventListener("change", (e) => ((filter.role = e.target.value), drawList()));
    $("#status").addEventListener("change", (e) => ((filter.status = e.target.value), drawList()));
    $("#add").onclick = () => userDialog(null);
    $("#import").onclick = importDialog;
    $("#list").addEventListener("click", async (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      const user = users.find((u) => u.id === (b.dataset.edit || b.dataset.reset || b.dataset.status || b.dataset.access));
      if (!user) return;
      if (b.dataset.edit) return userDialog(user);
      if (b.dataset.access) return moduleAccessDialog(user);
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

  /* User Group Manage（只限 super_admin）
     左边：还没有任何群组的人（Pending assignment），拖到右边的群组卡片就加入；手机可点名字选群组。
     右边：每个群组一张卡片：成员（× 移出）＋ Group Access（这个群组能看到哪些 App）。 */
  // ================================================================ 群组列表（User & Group Manage）
  // Business（gw_groups）→ Company（gw_companies，经由 gw_business_companies 连结）；把左边的人拖进某个 Business 底下的某个 Company
  async function groupsTab() {
    const seq = routeSeq;
    const tg = (k, v) => t("admin.groups." + k, v);
    const tu2 = (k, v) => t("admin.userGroups." + k, v);
    const [allGroups, users, members, companies, grantRows, links] = await Promise.all([
      sb.from("gw_groups").select("*").order("sort_order").order("name"),
      sb.from("gw_profiles").select("id, full_name, email, status, role").order("full_name"),
      sb.from("gw_group_members").select("group_id, user_id, company_id"),
      sb.from("gw_companies").select("*").eq("is_active", true).order("sort_order").order("name"),
      sb.from("gw_group_modules").select("group_id, module_id"),
      sb.from("gw_business_companies").select("group_id, company_id"),
    ]).then((r) => r.map((x) => (Array.isArray(x) ? x : x.data || [])));
    if (stale(seq)) return;

    // 角色只看到自己管的 Business（自己是成员的其他 Business 不能在这里管）
    const groups = allGroups.filter((g) => isSuper || (me.businessIds || []).includes(g.id));
    const userById = new Map(users.map((u) => [u.id, u]));
    // "群组:用户" → company_id（null = 还没分到 Company）
    const memberMap = new Map(members.map((m) => [m.group_id + ":" + m.user_id, m.company_id]));
    const appCount = (gid) => grantRows.filter((g) => g.group_id === gid).length;
    let leftMode = "pending";
    let query = "";
    let sortables = [];
    const groupsOf = (uid) => groups.filter((g) => memberMap.has(g.id + ":" + uid));
    const companiesOf = (gid) => companies.filter((c) => links.some((l) => l.group_id === gid && l.company_id === c.id));
    const membersIn = (gid, cid) => users.filter((u) => memberMap.has(gid + ":" + u.id) && (memberMap.get(gid + ":" + u.id) || null) === cid);

    const chip = (u, extra) => `<div data-user="${u.id}" class="gw-user flex cursor-grab items-center gap-2 rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-sm shadow-sm dark:border-slate-700 dark:bg-slate-800 ${u.status === "disabled" ? "opacity-50" : ""}">
        <span class="flex size-7 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold dark:bg-slate-700">${esc(u.full_name.slice(0, 1))}</span>
        <span class="min-w-0 flex-1"><span class="block truncate font-medium">${esc(u.email)}</span><span class="block truncate text-xs text-slate-500">${esc(u.full_name)}</span></span>
        ${extra || ""}
      </div>`;
    const zone = (g, c, mems) => `<div>
        <p class="mb-1 flex items-center gap-1.5 text-xs font-semibold ${c ? "text-slate-700 dark:text-slate-200" : "text-slate-400"}">${icon(c ? "building-2" : "circle-dashed", "size-3.5")}${esc(c ? c.name : tu2("noCompany"))}<span class="font-normal text-slate-400">(${mems.length})</span></p>
        <div data-drop="${g.id}" data-company="${c ? c.id : ""}" class="gw-drop min-h-14 space-y-1.5 rounded-xl border-2 border-dashed border-slate-200 p-2 dark:border-slate-700">
          ${mems.length ? mems.map((u) => chip(u, `<button data-apps="${g.id}:${u.id}" aria-label="${esc(tu2("apps"))}" title="${esc(tu2("apps"))}" class="no-drag rounded p-1 text-slate-400 hover:bg-emerald-50 hover:text-emerald-600">${icon("layout-grid")}</button><button data-out="${g.id}:${u.id}" aria-label="${esc(tu2("removeMember"))}" title="${esc(tu2("removeMember"))}" class="no-drag rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600">${icon("x")}</button>`)).join("") : `<p class="ug-empty py-2 text-center text-xs text-slate-400">${esc(tu2("dropHere"))}</p>`}
        </div>
      </div>`;

    function draw() {
      sortables.forEach((x) => x.destroy());
      sortables = [];
      const pending = users.filter((u) => u.status === "active" && u.role !== "super_admin" && groupsOf(u.id).length === 0);
      const q = query.trim().toLowerCase();
      const leftList = (leftMode === "pending" ? pending : users).filter((u) => !q || (u.full_name + " " + u.email).toLowerCase().includes(q));

      view.innerHTML = `<div class="grid gap-5 lg:grid-cols-[18rem_1fr]">
        <aside class="space-y-3 lg:sticky lg:top-20 lg:self-start">
          <div class="${cls.card} p-3">
            <div class="mb-2 inline-flex w-full rounded-lg border border-slate-300 p-0.5 dark:border-slate-700">
              <button data-left="pending" class="flex-1 rounded-md px-2 py-1 text-sm font-medium ${leftMode === "pending" ? "bg-amber-500 text-white" : "text-slate-600 dark:text-slate-300"}">${esc(tu2("pending"))} (${pending.length})</button>
              <button data-left="all" class="flex-1 rounded-md px-2 py-1 text-sm font-medium ${leftMode === "all" ? "bg-slate-700 text-white" : "text-slate-600 dark:text-slate-300"}">${esc(tu2("allUsers"))}</button>
            </div>
            <p class="mb-2 text-xs text-slate-500">${esc(tu2(leftMode === "pending" ? "pendingHint" : "allUsersHint"))}</p>
            <input id="ug-q" type="search" value="${esc(query)}" placeholder="${esc(t("admin.users.search"))}" class="${cls.input} mb-2 h-9">
            <div id="ug-left" class="max-h-[60vh] space-y-2 overflow-y-auto">
              ${
                leftList.length
                  ? leftList.map((u) => chip(u, leftMode === "all" ? `<span class="text-[11px] text-slate-400">${groupsOf(u.id).length}</span>` : "")).join("")
                  : `<p class="py-6 text-center text-sm text-slate-400">${esc(tu2(leftMode === "pending" ? "pendingEmpty" : "noUsers"))}</p>`
              }
            </div>
          </div>
        </aside>
        <section class="space-y-4">
          <p class="text-sm text-slate-500">${esc(tu2("description"))}</p>
          ${
            groups.length
              ? `<div class="grid gap-4 xl:grid-cols-2">${groups
                  .map((g) => {
                    const comps = companiesOf(g.id);
                    const loose = membersIn(g.id, null);
                    return `<div class="${cls.card} flex flex-col p-4">
                      <div class="mb-3 flex items-start gap-2">
                        <span class="flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-200">${icon("briefcase-business", "size-5")}</span>
                        <div class="min-w-0 flex-1">
                          <div class="flex flex-wrap items-center gap-2"><span class="font-semibold">${esc(g.name)}</span></div>
                          <a href="${isSuper ? "#business" : "#access"}" class="text-xs text-slate-500 hover:underline">${esc(tu2("appsCount", { count: appCount(g.id) }))}</a>
                        </div>
                      </div>
                      <div class="space-y-3">
                        ${comps.map((c) => zone(g, c, membersIn(g.id, c.id))).join("")}
                        ${!comps.length || loose.length ? zone(g, null, loose) : ""}
                        ${comps.length ? "" : `<p class="text-xs text-slate-400">${esc(tu2("noCompanies"))} <a href="#company" class="underline">${esc(t("admin.tabs.company"))}</a></p>`}
                      </div>
                    </div>`;
                  })
                  .join("")}</div>`
              : `<div class="${cls.empty}">${esc(tu2("noBusiness"))} <a href="#business" class="font-medium underline">${esc(t("admin.sections.master"))} → ${esc(t("admin.tabs.business"))}</a></div>`
          }
        </section>
      </div>`;
      refreshIcons();

      // 拖拉：左边名单 → Company；Company 之间也可以拖（只限同一个 Business）
      sortables.push(window.Sortable.create($("#ug-left"), { group: { name: "ug", pull: "clone", put: false }, sort: false, delay: 200, delayOnTouchOnly: true, filter: ".no-drag", animation: 150 }));
      $$(".gw-drop").forEach((el) =>
        sortables.push(
          window.Sortable.create(el, {
            group: { name: "biz-" + el.dataset.drop, pull: true, put: ["ug", "biz-" + el.dataset.drop] },
            sort: false,
            delay: 200,
            delayOnTouchOnly: true,
            animation: 150,
            filter: ".no-drag",
            onAdd: (evt) => {
              const uid = evt.item.dataset.user;
              evt.item.remove();
              place(el.dataset.drop, el.dataset.company || null, uid);
            },
          }),
        ),
      );
      $("#ug-q").addEventListener("input", (e) => {
        query = e.target.value;
        const pos = e.target.selectionStart;
        draw();
        const input = $("#ug-q");
        input.focus();
        input.setSelectionRange(pos, pos);
      });
    }

    // 放进某个 Business 的某个 Company：还不是成员就新增，已经是成员就换 Company
    async function place(gid, cid, uid) {
      const key = gid + ":" + uid;
      const g = groups.find((x) => x.id === gid);
      const c = companies.find((x) => x.id === cid);
      const where = c ? g.name + " · " + c.name : g.name;
      if (memberMap.has(key)) {
        if ((memberMap.get(key) || null) === cid) return draw(), toast(tu2("alreadyMember"));
        const { error } = await sb.from("gw_group_members").update({ company_id: cid }).eq("group_id", gid).eq("user_id", uid);
        if (error) return draw(), setMsg(tg("saveFailed"));
      } else {
        const { error } = await sb.from("gw_group_members").insert({ group_id: gid, user_id: uid, company_id: cid });
        if (error) return draw(), setMsg(tg("saveFailed"));
      }
      memberMap.set(key, cid);
      toast(tu2("added", { name: userById.get(uid).email, group: where }));
      draw();
    }

    // 手机：点名字选 Business → Company
    function pick(uid) {
      const u = userById.get(uid);
      const m = modal(
        tu2("addToGroup", { name: u.email }),
        groups.length
          ? `<div class="space-y-4">${groups
              .map((g) => {
                const opts = [...companiesOf(g.id).map((c) => [c.id, c.name]), ...(companiesOf(g.id).length ? [] : [["", tu2("noCompany")]])];
                return `<div><p class="mb-1.5 text-xs font-bold tracking-wider text-slate-500 uppercase">${esc(g.name)}</p><div class="space-y-1.5">${opts
                  .map(([cid, label]) => {
                    const here = memberMap.has(g.id + ":" + uid) && (memberMap.get(g.id + ":" + uid) || "") === cid;
                    return `<button data-pick="${g.id}" data-company="${cid}" ${here ? "disabled" : ""} class="flex w-full items-center justify-between rounded-xl border border-slate-200 px-3 py-2.5 text-left text-sm hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"><span class="font-medium">${esc(label)}</span>${here ? icon("check", "size-4 text-emerald-600") : icon("plus", "size-4")}</button>`;
                  })
                  .join("")}</div></div>`;
              })
              .join("")}</div>`
          : empty(tu2("noBusiness")),
      );
      refreshIcons();
      m.el.addEventListener("click", (e) => {
        const b = e.target.closest("[data-pick]");
        if (b) (m.close(), place(b.dataset.pick, b.dataset.company || null, uid));
      });
    }

    view.onclick = async (e) => {
      const b = e.target.closest("button, [data-user]");
      if (!b) return;
      const d = b.dataset;
      if (d.left) return ((leftMode = d.left), draw());
      if (d.apps) {
        const [gid, uid] = d.apps.split(":");
        return moduleAccessDialog(userById.get(uid), gid);
      }
      if (d.out) {
        const [gid, uid] = d.out.split(":");
        const { error } = await sb.from("gw_group_members").delete().eq("group_id", gid).eq("user_id", uid);
        if (error) return setMsg(tg("saveFailed"));
        memberMap.delete(gid + ":" + uid);
        return draw();
      }
      // 点名单里的名字：选 Business / Company（手机不方便拖拉时用）
      if (d.user && !e.target.closest(".no-drag")) return pick(d.user);
    };
    draw();
  }

  // ================================================================ 角色（Master Manage；super_admin 自己命名、设定每个角色能做什么）
  async function rolesTab() {
    const seq = routeSeq;
    const tr = (k, v) => t("admin.roles." + k, v);
    const tg = (k, v) => t("admin.groups." + k, v);
    const [roles, rb, rm, groups, gm, mods, users] = await Promise.all([
      sb.from("gw_roles").select("*").order("sort_order").order("name"),
      sb.from("gw_role_businesses").select("role_id, group_id"),
      sb.from("gw_role_modules").select("role_id, group_id, module_id"),
      sb.from("gw_groups").select("id, name").order("sort_order").order("name"),
      sb.from("gw_group_modules").select("group_id, module_id"),
      sb.from("gw_modules").select("id, name, icon").order("sort_order").order("name"),
      sb.from("gw_profiles").select("id, role_id"),
    ]).then((r) => r.map((x) => x.data || []));
    if (stale(seq)) return;
    const modById = new Map(mods.map((m) => [m.id, m]));
    const groupName = new Map(groups.map((g) => [g.id, g.name]));
    const modsOf = (gid) => gm.filter((x) => x.group_id === gid && modById.has(x.module_id)).map((x) => modById.get(x.module_id));

    view.innerHTML = `<div class="space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <p class="text-sm text-slate-500">${esc(tr("description"))}</p>
        <button id="role-add" class="${btn("primary")}">${icon("plus")} ${esc(tr("add"))}</button>
      </div>
      ${
        roles.length
          ? `<div class="grid gap-4 xl:grid-cols-2">${roles
              .map((r) => {
                const biz = rb.filter((x) => x.role_id === r.id);
                return `<div class="${cls.card} p-4">
                  <div class="flex items-start gap-2">
                    <span class="flex size-9 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-600 dark:bg-amber-900/30 dark:text-amber-300">${icon("shield-check", "size-5")}</span>
                    <div class="min-w-0 flex-1">
                      <div class="flex flex-wrap items-center gap-2"><span class="font-semibold">${esc(r.name)}</span>${r.can_post_notice ? badge(tr("canPost"), "green") : ""}</div>
                      <p class="text-xs text-slate-500">${esc(tr("people", { count: users.filter((u) => u.role_id === r.id).length }))}${r.description ? " · " + esc(r.description) : ""}</p>
                    </div>
                    <button data-edit="${r.id}" aria-label="${esc(tg("edit"))}" class="${btn("ghost", "sm")}">${icon("pencil")}</button>
                    <button data-del="${r.id}" aria-label="${esc(tg("delete"))}" class="${btn("ghost", "sm")} text-red-600 dark:text-red-400">${icon("trash-2")}</button>
                  </div>
                  <div class="mt-3 space-y-2">${
                    biz.length
                      ? biz
                          .map((b) => {
                            const ms = rm.filter((x) => x.role_id === r.id && x.group_id === b.group_id).map((x) => modById.get(x.module_id)).filter(Boolean);
                            return `<div class="rounded-xl bg-slate-50 px-3 py-2 dark:bg-white/5">
                              <p class="flex items-center gap-1.5 text-sm font-medium">${icon("briefcase-business", "size-4 text-brand-600")}${esc(groupName.get(b.group_id) || "")}</p>
                              <p class="mt-0.5 text-xs text-slate-500">${ms.length ? esc(tr("manages", { list: ms.map((m) => m.name).join(", ") })) : esc(tr("placeOnly"))}</p>
                            </div>`;
                          })
                          .join("")
                      : `<p class="text-sm text-slate-400">${esc(tr("noBusiness"))}</p>`
                  }</div>
                </div>`;
              })
              .join("")}</div>`
          : empty(tr("empty"))
      }
    </div>`;
    refreshIcons();

    function dialog(r) {
      const bizOn = new Set(r ? rb.filter((x) => x.role_id === r.id).map((x) => x.group_id) : []);
      const modOn = new Set(r ? rm.filter((x) => x.role_id === r.id).map((x) => x.group_id + ":" + x.module_id) : []);
      const m = modal(
        r ? tr("editTitle") : tr("addTitle"),
        `<form class="space-y-4">
          <div data-err></div>
          ${field(tr("name"), `<input name="name" required maxlength="60" value="${esc(r ? r.name : "")}" placeholder="${esc(tr("namePlaceholder"))}" class="${cls.input}">`)}
          ${field(tg("descriptionLabel"), `<input name="description" value="${esc(r ? r.description || "" : "")}" class="${cls.input}">`)}
          <label class="flex items-center gap-2 text-sm"><input type="checkbox" name="can_post_notice" ${r && r.can_post_notice ? "checked" : ""} class="size-4 accent-emerald-600"> ${esc(tr("canPostLabel"))}</label>
          <div>
            <p class="${cls.label}">${esc(tr("scope"))}</p>
            <p class="mb-2 text-xs text-slate-500">${esc(tr("scopeHint"))}</p>
            ${
              groups.length
                ? `<div class="space-y-2">${groups
                    .map(
                      (g) => `<div class="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                        <label class="flex items-center gap-2 text-sm font-medium"><input type="checkbox" data-biz="${g.id}" ${bizOn.has(g.id) ? "checked" : ""} class="size-4 accent-emerald-600">${icon("briefcase-business", "size-4 text-brand-600")}${esc(g.name)}</label>
                        <div data-biz-mods="${g.id}" class="mt-2 ml-6 flex-wrap gap-x-4 gap-y-1.5 ${bizOn.has(g.id) ? "flex" : "hidden"}">
                          ${
                            modsOf(g.id).length
                              ? modsOf(g.id)
                                  .map((mod) => `<label class="flex items-center gap-1.5 text-sm"><input type="checkbox" data-mod="${g.id}:${mod.id}" ${modOn.has(g.id + ":" + mod.id) ? "checked" : ""} class="size-4 accent-emerald-600">${esc(mod.name)}</label>`)
                                  .join("")
                              : `<span class="text-xs text-slate-400">${esc(tr("noModules"))}</span>`
                          }
                        </div>
                      </div>`,
                    )
                    .join("")}</div>`
                : `<p class="text-sm text-slate-400">${esc(t("admin.userGroups.noBusiness"))}</p>`
            }
          </div>
          <div class="flex justify-end gap-2">
            <button type="button" data-cancel class="${btn("secondary")}">${esc(tg("cancel"))}</button>
            <button type="submit" class="${btn("primary")}">${esc(tg("save"))}</button>
          </div>
        </form>`,
        { wide: true },
      );
      refreshIcons();
      $("[data-cancel]", m.el).onclick = m.close;
      m.el.addEventListener("change", (e) => {
        const b = e.target.closest("[data-biz]");
        if (!b) return;
        const box = $(`[data-biz-mods="${b.dataset.biz}"]`, m.el);
        box.classList.toggle("hidden", !b.checked);
        box.classList.toggle("flex", b.checked);
        if (!b.checked) $$("[data-mod]", box).forEach((x) => (x.checked = false));
      });
      $("form", m.el).addEventListener("submit", async (e) => {
        e.preventDefault();
        const f = e.target;
        const fail = (error) => ($("[data-err]", m.el).innerHTML = alertBox(error && error.code === "23505" ? tr("duplicate") : tg("saveFailed")));
        const row = { name: f.name.value.trim(), description: f.description.value.trim() || null, can_post_notice: f.can_post_notice.checked };
        const saved = r ? await sb.from("gw_roles").update(row).eq("id", r.id).select().single() : await sb.from("gw_roles").insert(row).select().single();
        if (saved.error) return fail(saved.error);
        const id = saved.data.id;
        const wantBiz = $$("[data-biz]", m.el).filter((x) => x.checked).map((x) => x.dataset.biz);
        const wantMod = $$("[data-mod]", m.el).filter((x) => x.checked).map((x) => x.dataset.mod).filter((k) => wantBiz.includes(k.split(":")[0]));
        // 先拿掉不要的模块、Business，再加新的（模块要等 Business 加好）
        const dropMod = [...modOn].filter((k) => !wantMod.includes(k));
        const dropBiz = [...bizOn].filter((g) => !wantBiz.includes(g));
        for (const k of dropMod) {
          const [gid, mid] = k.split(":");
          const { error } = await sb.from("gw_role_modules").delete().eq("role_id", id).eq("group_id", gid).eq("module_id", mid);
          if (error) return fail(error);
        }
        if (dropBiz.length) {
          const { error } = await sb.from("gw_role_businesses").delete().eq("role_id", id).in("group_id", dropBiz);
          if (error) return fail(error);
        }
        const addBiz = wantBiz.filter((g) => !bizOn.has(g));
        if (addBiz.length) {
          const { error } = await sb.from("gw_role_businesses").insert(addBiz.map((group_id) => ({ role_id: id, group_id })));
          if (error) return fail(error);
        }
        const addMod = wantMod.filter((k) => !modOn.has(k));
        if (addMod.length) {
          const { error } = await sb.from("gw_role_modules").insert(addMod.map((k) => ({ role_id: id, group_id: k.split(":")[0], module_id: k.split(":")[1] })));
          if (error) return fail(error);
        }
        m.close();
        rolesTab();
      });
    }

    view.onclick = async (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.id === "role-add") return dialog(null);
      const r = roles.find((x) => x.id === (b.dataset.edit || b.dataset.del));
      if (!r) return;
      if (b.dataset.edit) return dialog(r);
      if (!(await confirmDialog(tr("deleteTitle"), tr("deleteBody", { name: r.name }), tg("delete"), tg("cancel")))) return;
      const { error } = await sb.from("gw_roles").delete().eq("id", r.id);
      if (error) setMsg(tg("saveFailed"));
      rolesTab();
    };
  }

  // ================================================================ Business（Master Manage；就是群组，决定成员能用哪些 App）
  async function businessTab() {
    const seq = routeSeq;
    const tb = (k, v) => t("admin.business." + k, v);
    const tg = (k, v) => t("admin.groups." + k, v);
    const [groups, members, companies, modules, grantRows] = await Promise.all([
      sb.from("gw_groups").select("*").order("sort_order").order("name"),
      sb.from("gw_group_members").select("group_id, user_id"),
      sb.from("gw_business_companies").select("group_id, company_id"),
      sb.from("gw_modules").select("id, code, name, icon, is_active").order("sort_order").order("name"),
      sb.from("gw_group_modules").select("group_id, module_id"),
    ]).then((r) => r.map((x) => (Array.isArray(x) ? x : x.data || [])));
    if (stale(seq)) return;
    let grantSet = new Set(grantRows.map((g) => g.group_id + ":" + g.module_id));

    function draw() {
      view.innerHTML = `<div class="space-y-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="text-sm text-slate-500">${esc(tb("description"))}</p>
          <button id="biz-add" class="${btn("primary")}">${icon("plus")} ${esc(tb("add"))}</button>
        </div>
        ${
          groups.length
            ? `<div class="grid gap-4 xl:grid-cols-2">${groups
                .map(
                  (g) => `<div class="${cls.card} p-4">
                    <div class="flex items-start gap-2">
                      <span class="flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-200">${icon("briefcase-business", "size-5")}</span>
                      <div class="min-w-0 flex-1">
                        <div class="flex flex-wrap items-center gap-2"><span class="font-semibold">${esc(g.name)}</span></div>
                        <p class="text-xs text-slate-500">${esc(tb("counts", { companies: companies.filter((c) => c.group_id === g.id).length, members: members.filter((m) => m.group_id === g.id).length }))}${g.description ? " · " + esc(g.description) : ""}</p>
                      </div>
                      <button data-edit="${g.id}" aria-label="${esc(tg("edit"))}" class="${btn("ghost", "sm")}">${icon("pencil")}</button>
                      <button data-del="${g.id}" aria-label="${esc(tg("delete"))}" class="${btn("ghost", "sm")} text-red-600 dark:text-red-400">${icon("trash-2")}</button>
                    </div>
                    <p class="mt-3 mb-1.5 text-[11px] font-bold tracking-wider text-slate-500 uppercase">${esc(tb("access"))}</p>
                    <div class="flex flex-wrap gap-1.5">
                      ${
                        modules.length
                          ? modules
                              .map((mod) => {
                                const on = grantSet.has(g.id + ":" + mod.id);
                                return `<button data-grant="${g.id}:${mod.id}" aria-pressed="${on}" class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${
                                  on ? "border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300" : "border-slate-300 text-slate-500 dark:border-slate-700"
                                } ${mod.is_active ? "" : "opacity-50"}">${icon(on ? "check" : "plus", "size-3")}${esc(mod.name)}</button>`;
                              })
                              .join("")
                          : `<span class="text-xs text-slate-400">${esc(t("admin.userGroups.noModules"))}</span>`
                      }
                    </div>
                  </div>`,
                )
                .join("")}</div>`
            : empty(tb("empty"))
        }
      </div>`;
      refreshIcons();
    }

    function dialog(g) {
      const m = modal(
        g ? tb("editTitle") : tb("addTitle"),
        `<form class="space-y-4">
          <div data-err></div>
          ${field(tg("name"), `<input name="name" required value="${esc(g ? g.name : "")}" class="${cls.input}">`)}
          ${field(tg("descriptionLabel"), `<input name="description" value="${esc(g ? g.description || "" : "")}" class="${cls.input}">`)}
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
        const row = { name: f.name.value.trim(), description: f.description.value.trim() || null, sort_order: Number(f.sort_order.value) || 0 };
        const { error } = g ? await sb.from("gw_groups").update(row).eq("id", g.id) : await sb.from("gw_groups").insert(row);
        if (error) return ($("[data-err]", m.el).innerHTML = alertBox(error.code === "23505" ? tb("duplicate") : tg("saveFailed")));
        m.close();
        businessTab();
      });
    }

    view.onclick = async (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      const d = b.dataset;
      if (b.id === "biz-add") return dialog(null);
      if (d.edit) return dialog(groups.find((x) => x.id === d.edit));
      if (d.del) {
        const g = groups.find((x) => x.id === d.del);
        if (!(await confirmDialog(tb("deleteTitle"), tb("deleteBody", { name: g.name }), tg("delete"), tg("cancel")))) return;
        const { error } = await sb.from("gw_groups").delete().eq("id", g.id);
        if (error) setMsg(tg("saveFailed"));
        return businessTab();
      }
      if (d.grant) {
        const [gid, mid] = d.grant.split(":");
        const on = grantSet.has(d.grant);
        const { error } = on
          ? await sb.from("gw_group_modules").delete().eq("group_id", gid).eq("module_id", mid)
          : await sb.from("gw_group_modules").insert({ group_id: gid, module_id: mid });
        if (error) return setMsg(tg("saveFailed"));
        on ? grantSet.delete(d.grant) : grantSet.add(d.grant);
        return draw();
      }
    };
    draw();
  }

  // ================================================================ Company（Master Manage；独立主资料，可以属于多个 Business，对应到现有系统）
  async function companyTab() {
    const seq = routeSeq;
    const tc = (k, v) => t("admin.company." + k, v);
    const tg = (k, v) => t("admin.groups." + k, v);
    const [companies, groups, links, members, mappings, modules] = await Promise.all([
      sb.from("gw_companies").select("*").order("sort_order").order("name"),
      sb.from("gw_groups").select("id, name").order("sort_order").order("name"),
      sb.from("gw_business_companies").select("group_id, company_id"),
      sb.from("gw_group_members").select("company_id"),
      sb.from("gw_company_mappings").select("*").order("created_at"),
      sb.from("gw_modules").select("id, code, name, kind").order("sort_order").order("name"),
    ]).then((r) => r.map((x) => x.data || []));
    if (stale(seq)) return;
    const modById = new Map(modules.map((m) => [m.id, m]));
    const count = (cid) => members.filter((m) => m.company_id === cid).length;
    let linkSet = new Set(links.map((l) => l.group_id + ":" + l.company_id));
    let query = "";

    function draw() {
      const q = query.trim().toLowerCase();
      const list = companies.filter((c) => !q || [c.code, c.name, c.short_name, c.registration_no].filter(Boolean).join(" ").toLowerCase().includes(q));
      view.innerHTML = `<div class="space-y-4">
        <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
          <p class="flex-1 text-sm text-slate-500">${esc(tc("description"))}</p>
          <input id="co-q" type="search" value="${esc(query)}" placeholder="${esc(tc("search"))}" class="${cls.input} h-9 sm:w-56">
          <button id="co-add" class="${btn("primary")}">${icon("plus")} ${esc(tc("add"))}</button>
        </div>
        ${
          list.length
            ? `<div class="grid gap-4 xl:grid-cols-2">${list
                .map((c) => {
                  const maps = mappings.filter((m) => m.company_id === c.id);
                  return `<div class="${cls.card} p-4 ${c.is_active ? "" : "opacity-60"}">
                    <div class="flex items-start gap-2">
                      <span class="flex size-9 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-600 dark:bg-white/10 dark:text-slate-300">${icon("building-2", "size-5")}</span>
                      <div class="min-w-0 flex-1">
                        <div class="flex flex-wrap items-center gap-2">
                          <span class="font-semibold">${esc(c.name)}</span>
                          ${c.code ? `<span class="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs dark:bg-white/10">${esc(c.code)}</span>` : badge(tc("noCode"), "amber")}
                          ${c.is_active ? "" : badge(tc("inactive"))}
                        </div>
                        <p class="text-xs text-slate-500">${esc([c.short_name, c.registration_no, tc("members", { count: count(c.id) })].filter(Boolean).join(" · "))}</p>
                      </div>
                      <button data-edit="${c.id}" aria-label="${esc(tg("edit"))}" class="${btn("ghost", "sm")}">${icon("pencil")}</button>
                    </div>
                    <p class="mt-3 mb-1.5 text-[11px] font-bold tracking-wider text-slate-500 uppercase">${esc(tc("businesses"))}</p>
                    <div class="flex flex-wrap gap-1.5">${
                      groups.length
                        ? groups
                            .map((g) => {
                              const on = linkSet.has(g.id + ":" + c.id);
                              return `<button data-link="${g.id}:${c.id}" aria-pressed="${on}" class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${
                                on ? "border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-700/20 dark:text-brand-100" : "border-slate-300 text-slate-500 dark:border-slate-700"
                              }">${icon(on ? "check" : "plus", "size-3")}${esc(g.name)}</button>`;
                            })
                            .join("")
                        : `<span class="text-xs text-slate-400">${esc(tc("noBusiness"))}</span>`
                    }</div>
                    <div class="mt-3 mb-1.5 flex items-center justify-between">
                      <p class="text-[11px] font-bold tracking-wider text-slate-500 uppercase">${esc(tc("mappings"))}</p>
                      <button data-map-add="${c.id}" class="${btn("ghost", "sm")}">${icon("link-2")} ${esc(tc("addMapping"))}</button>
                    </div>
                    ${
                      maps.length
                        ? `<div class="divide-y divide-slate-100 rounded-xl border border-slate-200 text-sm dark:divide-slate-800 dark:border-slate-800">${maps
                            .map((m) => {
                              const mod = modById.get(m.module_id);
                              return `<div class="flex items-center gap-2 px-3 py-1.5">
                                <span class="min-w-0 flex-1 truncate"><span class="font-medium">${esc(mod ? mod.name : "—")}</span> → <span class="font-mono">${esc(m.external_id)}</span>${m.external_name ? ` <span class="text-slate-500">(${esc(m.external_name)})</span>` : ""}</span>
                                <button data-map-del="${m.id}" aria-label="${esc(tg("delete"))}" class="${btn("ghost", "sm")} text-red-600 dark:text-red-400">${icon("x")}</button>
                              </div>`;
                            })
                            .join("")}</div>`
                        : `<p class="text-xs text-slate-400">${esc(tc("noMappings"))}</p>`
                    }
                  </div>`;
                })
                .join("")}</div>`
            : empty(tc(companies.length ? "noMatch" : "empty"))
        }
      </div>`;
      refreshIcons();
      $("#co-q").addEventListener("input", (e) => {
        query = e.target.value;
        const pos = e.target.selectionStart;
        draw();
        const input = $("#co-q");
        input.focus();
        input.setSelectionRange(pos, pos);
      });
    }

    function dialog(c) {
      const v = c || { code: "", name: "", short_name: "", registration_no: "", is_active: true, sort_order: companies.length };
      const m = modal(
        c ? tc("editTitle") : tc("addTitle"),
        `<form class="space-y-4"><div data-err></div>
          <div class="grid gap-4 sm:grid-cols-2">
            ${field(tc("code"), `<input name="code" required maxlength="20" value="${esc(v.code || "")}" ${c && c.code ? "readonly" : ""} class="${cls.input} font-mono uppercase">`, c && c.code ? tc("codeLocked") : tc("codeHint"))}
            ${field(tc("name"), `<input name="name" required maxlength="100" value="${esc(v.name)}" class="${cls.input}">`)}
            ${field(tc("shortName"), `<input name="short_name" maxlength="40" value="${esc(v.short_name || "")}" class="${cls.input}">`)}
            ${field(tc("registrationNo"), `<input name="registration_no" maxlength="40" value="${esc(v.registration_no || "")}" class="${cls.input}">`)}
            ${field(tg("sortOrder"), `<input name="sort_order" type="number" value="${v.sort_order || 0}" class="${cls.input}">`)}
            ${field(tc("status"), select("is_active", [["1", tc("active")], ["0", tc("inactive")]], v.is_active ? "1" : "0"))}
          </div>
          <div class="flex justify-between gap-2">
            ${c ? `<button type="button" data-del class="${btn("ghost")} text-red-600 dark:text-red-400">${icon("trash-2")} ${esc(tg("delete"))}</button>` : "<span></span>"}
            <div class="flex gap-2"><button type="button" data-cancel class="${btn("secondary")}">${esc(tg("cancel"))}</button><button type="submit" class="${btn("primary")}">${esc(tg("save"))}</button></div>
          </div>
        </form>`,
        { wide: true },
      );
      refreshIcons();
      $("[data-cancel]", m.el).onclick = m.close;
      if (c)
        $("[data-del]", m.el).onclick = async () => {
          if (!(await confirmDialog(tc("deleteTitle"), tc("deleteBody", { name: c.name }), tg("delete"), tg("cancel")))) return;
          const { error } = await sb.from("gw_companies").delete().eq("id", c.id);
          if (error) return ($("[data-err]", m.el).innerHTML = alertBox(tc("inUse")));
          m.close();
          companyTab();
        };
      $("form", m.el).addEventListener("submit", async (e) => {
        e.preventDefault();
        const f = e.target;
        const row = {
          code: f.code.value.trim().toUpperCase(),
          name: f.name.value.trim(),
          short_name: f.short_name.value.trim() || null,
          registration_no: f.registration_no.value.trim() || null,
          sort_order: Number(f.sort_order.value) || 0,
          is_active: f.is_active.value === "1",
        };
        const { error } = c ? await sb.from("gw_companies").update(row).eq("id", c.id) : await sb.from("gw_companies").insert(row);
        if (error) return ($("[data-err]", m.el).innerHTML = alertBox(tc(error.code === "23505" ? "duplicate" : error.code === "23514" ? "badCode" : "saveFailed")));
        m.close();
        companyTab();
      });
    }

    function mappingDialog(c) {
      const m = modal(
        tc("mappingTitle", { name: c.name }),
        `<form class="space-y-4"><div data-err></div>
          <p class="text-sm text-slate-500">${esc(tc("mappingHint"))}</p>
          ${field(tc("system"), select("module_id", modules.map((x) => [x.id, x.name + " (" + x.code + ")"]), ""))}
          <div class="grid gap-4 sm:grid-cols-2">
            ${field(tc("externalId"), `<input name="external_id" required maxlength="100" class="${cls.input} font-mono">`, tc("externalIdHint"))}
            ${field(tc("externalName"), `<input name="external_name" maxlength="120" class="${cls.input}">`)}
          </div>
          ${field(tc("notes"), `<input name="notes" maxlength="300" class="${cls.input}">`)}
          <div class="flex justify-end gap-2"><button type="button" data-cancel class="${btn("secondary")}">${esc(tg("cancel"))}</button><button type="submit" class="${btn("primary")}">${esc(tg("save"))}</button></div>
        </form>`,
      );
      $("[data-cancel]", m.el).onclick = m.close;
      $("form", m.el).addEventListener("submit", async (e) => {
        e.preventDefault();
        const f = e.target;
        const { error } = await sb.from("gw_company_mappings").insert({
          company_id: c.id,
          module_id: f.module_id.value,
          external_id: f.external_id.value.trim(),
          external_name: f.external_name.value.trim() || null,
          notes: f.notes.value.trim() || null,
        });
        if (error) return ($("[data-err]", m.el).innerHTML = alertBox(tc(error.code === "23505" ? "mappingDuplicate" : "saveFailed")));
        m.close();
        companyTab();
      });
    }

    view.onclick = async (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      const d = b.dataset;
      if (b.id === "co-add") return dialog(null);
      if (d.edit) return dialog(companies.find((x) => x.id === d.edit));
      if (d.mapAdd) {
        if (!modules.length) return toast(tc("noSystems"));
        return mappingDialog(companies.find((x) => x.id === d.mapAdd));
      }
      if (d.mapDel) {
        const { error } = await sb.from("gw_company_mappings").delete().eq("id", d.mapDel);
        if (error) return setMsg(tg("saveFailed"));
        return companyTab();
      }
      if (d.link) {
        const [gid, cid] = d.link.split(":");
        const on = linkSet.has(d.link);
        if (on && members.length) {
          // 拿掉连结时，原本放在这个 Business 的这个 Company 的人会变成「没有 Company」
          const { count: n } = await sb.from("gw_group_members").select("user_id", { count: "exact", head: true }).eq("group_id", gid).eq("company_id", cid);
          if (n && !(await confirmDialog(tc("unlinkTitle"), tc("unlinkBody", { count: n }), tc("unlink"), tg("cancel")))) return;
        }
        const { error } = on
          ? await sb.from("gw_business_companies").delete().eq("group_id", gid).eq("company_id", cid)
          : await sb.from("gw_business_companies").insert({ group_id: gid, company_id: cid });
        if (error) return setMsg(tg("saveFailed"));
        on ? linkSet.delete(d.link) : linkSet.add(d.link);
        return draw();
      }
    };
    draw();
  }

  // ================================================================ Icon（只限 super_admin；资料表是 gw_modules）
  /* 类型：system = MJM Connect 旗下的系统（网址可以是这个网站里的路径，例如 diesel/index.html）
          link   = 现有系统或任何外部网站
     标签：Business（这个 Icon 属于哪些 Business，开权限时会出现在那里）＋ Company */
  async function modulesTab() {
    const seq = routeSeq;
    const tmod = (k, v) => t("admin.modules." + k, v);
    const [modules, keyRes, groups, companies, bizTags, coTags] = await Promise.all([
      sb.from("gw_modules").select("*").order("sort_order").order("name").then((r) => r.data || []),
      invoke("gw-admin", { action: "list_api_keys" }),
      sb.from("gw_groups").select("id, name").order("sort_order").order("name").then((r) => r.data || []),
      sb.from("gw_companies").select("id, code, name").order("sort_order").order("name").then((r) => r.data || []),
      sb.from("gw_group_modules").select("group_id, module_id").then((r) => r.data || []),
      sb.from("gw_module_companies").select("module_id, company_id").then((r) => r.data || []),
    ]);
    const groupName = new Map(groups.map((g) => [g.id, g.name]));
    const companyName = new Map(companies.map((c) => [c.id, c.code || c.name]));
    const tagsOf = (mid) => [
      ...bizTags.filter((x) => x.module_id === mid).map((x) => badge(groupName.get(x.group_id) || "—", "blue")),
      ...coTags.filter((x) => x.module_id === mid).map((x) => badge(companyName.get(x.company_id) || "—")),
    ];
    const keys = Object.fromEntries(((keyRes && keyRes.keys) || []).map((k) => [k.module_id, k.key_prefix]));
    const functionsUrl = GW_CONFIG.supabaseUrl + "/functions/v1";

    if (stale(seq)) return;
    view.innerHTML = `<div class="space-y-4">
      <div class="flex items-center justify-between gap-2">
        <p class="text-sm text-slate-500">${esc(tmod("description"))}</p>
        <button id="add" class="${btn("primary")} shrink-0 whitespace-nowrap">${icon("plus")} ${esc(tmod("add"))}</button>
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
                      ${badge(tmod("kinds." + m.kind), m.kind === "system" ? "amber" : "slate")}
                      ${badge(m.is_active ? tmod("active") : tmod("inactive"), m.is_active ? "green" : "slate")}
                      ${m.kind === "link" && m.access_level !== 1 ? badge(tmod("levels." + m.access_level), "blue") : ""}
                    </div>
                    <p class="mt-0.5 truncate text-sm text-slate-500">${esc(m.url)}</p>
                    ${tagsOf(m.id).length ? `<div class="mt-1 flex flex-wrap gap-1">${tagsOf(m.id).join("")}</div>` : `<p class="mt-0.5 text-xs text-amber-600">${esc(tmod("noTags"))}</p>`}
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
      const v = mod || { code: "", name: "", icon: "app-window", url: "https://", description: "", category: "", access_level: 1, is_active: true, open_mode: "new_tab", sort_order: 0, kind: "link" };
      let chosenIcon = v.icon;
      const bizOn = new Set(mod ? bizTags.filter((x) => x.module_id === mod.id).map((x) => x.group_id) : []);
      const coOn = new Set(mod ? coTags.filter((x) => x.module_id === mod.id).map((x) => x.company_id) : []);
      const tagBox = (name, list, on) =>
        list.length
          ? `<div class="flex flex-wrap gap-x-4 gap-y-1.5">${list.map(([id, label]) => `<label class="flex items-center gap-1.5 text-sm"><input type="checkbox" name="${name}" value="${id}" ${on.has(id) ? "checked" : ""} class="size-4 accent-emerald-600">${esc(label)}</label>`).join("")}</div>`
          : `<p class="text-xs text-slate-400">${esc(tmod("noOptions"))}</p>`;
      const m = modal(
        mod ? tmod("editTitle") : tmod("addTitle"),
        `<form class="space-y-4">
          <div data-err></div>
          <div class="grid gap-4 sm:grid-cols-3">
            ${field(tmod("kind"), select("kind", [["link", tmod("kinds.link")], ["system", tmod("kinds.system")]], v.kind), tmod("kindHint"))}
            ${field(tmod("code"), `<input name="code" required value="${esc(v.code)}" class="${cls.input} uppercase">`, tmod("codeHint"))}
            ${field(tmod("name"), `<input name="name" required value="${esc(v.name)}" class="${cls.input}">`)}
          </div>
          ${field(tmod("url"), `<input name="url" required value="${esc(v.url)}" class="${cls.input}">`, tmod("urlHint"))}
          ${field(tmod("descriptionLabel"), `<input name="description" maxlength="120" value="${esc(v.description || "")}" class="${cls.input}">`)}
          <div class="grid gap-4 sm:grid-cols-2">
            ${field(tmod("category"), `<input name="category" value="${esc(v.category || "")}" class="${cls.input}">`)}
            ${field(tmod("accessLevel"), select("access_level", [1, 2, 3].map((l) => [l, tmod("levels." + l)]), v.access_level))}
            ${field(tmod("openMode"), select("open_mode", [["new_tab", tmod("newTab")], ["same_tab", tmod("sameTab")]], v.open_mode))}
            ${field(tmod("sortOrder"), `<input name="sort_order" type="number" value="${v.sort_order}" class="${cls.input}">`)}
            ${field(tmod("status"), select("is_active", [["1", tmod("active")], ["0", tmod("inactive")]], v.is_active ? "1" : "0"))}
          </div>
          <div class="grid gap-4 sm:grid-cols-2">
            <div><p class="${cls.label}">${esc(tmod("businessTags"))}</p><p class="mb-1.5 text-xs text-slate-500">${esc(tmod("businessTagsHint"))}</p>${tagBox("biz", groups.map((g) => [g.id, g.name]), bizOn)}</div>
            <div><p class="${cls.label}">${esc(tmod("companyTags"))}</p><p class="mb-1.5 text-xs text-slate-500">${esc(tmod("companyTagsHint"))}</p>${tagBox("co", companies.map((c) => [c.id, (c.code ? c.code + " · " : "") + c.name]), coOn)}</div>
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
        // link：完整网址；system：这个网站里的路径（例如 diesel/index.html）或完整网址
        const url = f.url.value.trim();
        const relative = f.kind.value === "system" && /^[a-z0-9][a-z0-9/_.-]*$/i.test(url) && !url.includes("..");
        if (!relative) {
          try {
            const u = new URL(url);
            if (!["https:", "http:"].includes(u.protocol)) throw new Error();
          } catch (x) {
            return err("badUrl");
          }
        }
        const row = {
          code: f.code.value.trim().toUpperCase(),
          name: f.name.value.trim(),
          url,
          kind: f.kind.value,
          description: f.description.value.trim() || null,
          category: f.category.value.trim() || null,
          access_level: Number(f.access_level.value),
          open_mode: f.open_mode.value,
          sort_order: Number(f.sort_order.value) || 0,
          is_active: f.is_active.value === "1",
          icon: chosenIcon,
        };
        const saved = mod ? await sb.from("gw_modules").update(row).eq("id", mod.id).select().single() : await sb.from("gw_modules").insert(row).select().single();
        if (saved.error) return err(saved.error.code === "23505" ? "duplicate" : saved.error.code === "23514" ? "badCode" : "saveFailed");
        // 标签：比对勾选前后，加上新的、拿掉取消的
        const id = saved.data.id;
        const sync = async (table, col, before, after) => {
          const add = [...after].filter((x) => !before.has(x));
          const drop = [...before].filter((x) => !after.has(x));
          if (add.length) {
            const { error } = await sb.from(table).insert(add.map((x) => ({ module_id: id, [col]: x })));
            if (error) return error;
          }
          if (drop.length) {
            const { error } = await sb.from(table).delete().eq("module_id", id).in(col, drop);
            if (error) return error;
          }
        };
        const picked = (name) => new Set($$(`input[name=${name}]:checked`, f).map((x) => x.value));
        const tagError = (await sync("gw_group_modules", "group_id", bizOn, picked("biz"))) || (await sync("gw_module_companies", "company_id", coOn, picked("co")));
        if (tagError) return err("saveFailed");
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
    const [announcements, allGroups] = await Promise.all([
      sb.from("gw_announcements").select("*").order("created_at", { ascending: false }).then((r) => r.data || []),
      sb.from("gw_groups").select("id, name").order("sort_order").order("name").then((r) => r.data || []),
    ]);
    // 可以发给谁：super_admin 全公司或任何 Business；角色只能发给自己管的 Business
    const groups = allGroups.filter((g) => isSuper || (me.businessIds || []).includes(g.id));
    const groupName = new Map(allGroups.map((g) => [g.id, g.name]));
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
                    <div class="mb-1 flex flex-wrap items-center gap-2">${status(a)}${badge(ta("levels." + a.level), a.level === "warning" ? "amber" : "blue")}${badge(a.group_id ? groupName.get(a.group_id) || "—" : ta("allCompany"))}</div>
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
              select("group_id", [...(isSuper ? [["", ta("allCompany")]] : []), ...groups.map((g) => [g.id, g.name])], ""),
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
          group_id: f.group_id.value || null,
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
    const TARGETS = ["auth", "profiles", "roles", "role_businesses", "role_modules", "groups", "group_members", "companies", "business_companies", "company_mappings", "modules", "group_modules", "module_companies", "module_members", "announcements"];
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
        <span class="flex-1">${esc(tp("banner", { name: data.profile.full_name, email: data.profile.email }))}</span>
        <a href="#users" class="font-medium underline">${esc(tp("back"))}</a>
      </div>
      <div id="board"></div>
    </div>`;
    refreshIcons();
    GWHome.render($("#board"), data, { readOnly: true });
  }

  // ---------------------------------------------------------------- 分页切换（#users、#groups、#preview=id …）
  const HANDLERS = { users: usersTab, groups: groupsTab, access: accessTab, roles: rolesTab, business: businessTab, company: companyTab, modules: modulesTab, announcements: announcementsTab, audit: auditTab };
  async function route() {
    const hash = location.hash.slice(1) || TABS[0];
    const [name, arg] = hash.split("=");
    const active = name === "preview" ? (TABS.includes("users") ? "users" : TABS[0]) : HANDLERS[name] && TABS.includes(name) ? name : TABS[0];
    const section = SECTIONS.find(([, , tabs]) => tabs.includes(active));
    $("#sections").innerHTML =
      SECTIONS.length > 1
        ? SECTIONS.map(
            ([k, ic, tabs]) => `<a href="#${tabs[0]}" class="flex items-center justify-center gap-2 rounded-2xl px-5 py-3 text-sm font-semibold sm:justify-start ${
              k === section[0]
                ? "bg-slate-900 text-white shadow-md dark:bg-white dark:text-slate-900"
                : "border border-slate-200 bg-white text-slate-600 hover:text-slate-900 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300 dark:hover:text-white"
            }">${icon(ic, "size-5")}${esc(t("admin.sections." + k))}</a>`,
          ).join("")
        : "";
    $("#tabs").innerHTML = section[2]
      .map(
        (k) => `<a href="#${k}" class="rounded-lg px-3.5 py-1.5 text-sm font-medium whitespace-nowrap ${
          k === active ? "bg-white text-slate-900 shadow-sm dark:bg-slate-950 dark:text-white" : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
        }">${esc(t("admin.tabs." + k))}</a>`,
      )
      .join("");
    refreshIcons();
    routeSeq++;
    if (name !== "preview") setMsg("");
    view.onclick = null;
    view.onsubmit = null;
    view.onchange = null;
    view.innerHTML = GW.spinner();
    if (name === "preview" && arg) return previewTab(arg);
    await HANDLERS[active]();
  }
  window.addEventListener("hashchange", route);
  route();
})();
