/* ================================================================
   MJM Intranet — 权限后台
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
     自订角色    → 依角色功能：用户名单（只看）、群组列表、模块权限、操作记录
     模块管理员  → 模块权限（自己管理的模块）
     公告直接在首页的 Notice Board 发布、修改、删除 */
  const C = me.can;
  const canAccessPage = isSuper || C.can_view_user_group || C.can_grant_module || C.can_revoke_module || C.can_set_module_admin || me.adminModules > 0;
  const canGroupsPage = isSuper || C.can_view_user_group || C.can_add_business_user || C.can_remove_business_user;
  const canUsersPage = isSuper || C.can_view_users || canAccessPage;
  const SECTIONS = isSuper
    ? [
        ["userGroup", "users-round", ["groups", "users", "access"]],
        ["master", "database", ["roles", "business", "company", "sectors", "modules", "connector"]],
        ["audit", "scroll-text", ["audit"]],
      ]
    : [
        ["userGroup", "users-round", [...(canGroupsPage ? ["groups"] : []), ...(canUsersPage ? ["users"] : []), ...(canAccessPage ? ["access"] : [])]],
        ...(C.can_edit_module_name ? [["master", "database", ["modules"]]] : []),
        ...(C.can_view_audit ? [["audit", "scroll-text", ["audit"]]] : []),
      ].filter(([, , tabs]) => tabs.length);
  const TABS = SECTIONS.flatMap(([, , tabs]) => tabs);

  main.innerHTML = `<div class="space-y-5">
    <div class="relative flex min-h-10 flex-col items-center gap-2 sm:flex-row sm:justify-center">
      <a href="index.html" class="inline-flex self-start sm:absolute sm:left-0 sm:self-auto items-center gap-1 text-sm text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">${icon("arrow-left")} ${esc(t("admin.backToPortal"))}</a>
      <h1 class="text-xl font-semibold sm:text-2xl">${esc(t("admin.pageTitle"))}</h1>
    </div>
    <div id="sections" class="mx-auto w-full max-w-xl overflow-clip"></div>
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
      sb.from("gw_modules").select("id, code, name, icon, image_url, is_active").order("sort_order").order("name"),
      sb.from("gw_module_members").select("user_id, module_id, is_admin"),
      Promise.resolve({ data: [] }),
      sb.from("gw_profiles").select("id, full_name, email, role, status, user_code").order("full_name"),
      sb.from("gw_module_companies").select("module_id, company_id"),
      sb.from("gw_companies").select("id, code, name, short_name"),
    ]).then((r) => r.map((x) => x.data || []));
    const coName = new Map(companies.map((c) => [c.id, c.code || c.name]));
    const ctx = { groups, members, gm, mods, users, mine, coTags, companies, rows: new Map(rows.map((r) => [r.user_id + ":" + r.module_id, r])) };
    const inGroup = (uid, gid) => members.some((m) => m.user_id === uid && m.group_id === gid);
    const groupHas = (gid, mid) => gm.some((x) => x.group_id === gid && x.module_id === mid);
    const myAdmin = (mid) => !!(ctx.rows.get(me.id + ":" + mid) || {}).is_admin;
    const roleHas = (gid, mid, flag) => me.bizCan(gid, flag) && groupHas(gid, mid);
    const locked = (u) => u.id === me.id || u.role === "super_admin";
    // 在某个 Business 里，我能不能改这个人这个模块的 Access / Admin
    // 角色功能：加进模块 / 从模块移除 / 设定模块 Admin（模块 Admin 加、移除都可以）
    const adminReach = (gid, mid) => myAdmin(mid) && inGroup(me.id, gid) && groupHas(gid, mid);
    ctx.canGrant = (u, gid, mid) => !locked(u) && (isSuper || roleHas(gid, mid, "can_grant_module") || adminReach(gid, mid));
    ctx.canRevoke = (u, gid, mid) => !locked(u) && (isSuper || roleHas(gid, mid, "can_revoke_module") || adminReach(gid, mid));
    ctx.canAccess = (u, gid, mid) => (ctx.rows.has(u.id + ":" + mid) ? ctx.canRevoke(u, gid, mid) : ctx.canGrant(u, gid, mid));
    ctx.canAdmin = (u, gid, mid) => !locked(u) && (isSuper || roleHas(gid, mid, "can_set_module_admin"));
    ctx.inGroup = inGroup;
    ctx.companyTags = (mid) => coTags.filter((x) => x.module_id === mid).map((x) => coName.get(x.company_id)).filter(Boolean);
    ctx.groupHas = groupHas;
    // 我管得到的 (Business, 模块) 组合
    ctx.managedPairs = gm.filter((x) => isSuper || ["can_grant_module", "can_revoke_module", "can_set_module_admin"].some((f) => me.bizCan(x.group_id, f)) || (myAdmin(x.module_id) && inGroup(me.id, x.group_id)));
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

  // 用户资料窗的编辑模式：列出「全部」模块。
  //   - 模块有标到这个人所在的 Business → 可以勾 Access / Admin，旁边显示是哪个 Business、哪些 Company
  //   - 没有 → 也列出来但不能勾，说明原因（模块还没标 Business，或这个人不在那个 Business）
  function accessSections(ctx, user, dieselOf) {
    const ta = (k, v) => t("admin.users.accessDialog." + k, v);
    const gName = new Map(ctx.groups.map((g) => [g.id, g.name]));
    const myGids = ctx.groups.filter((g) => ctx.inGroup(user.id, g.id)).map((g) => g.id);
    const bizOf = (mid) => ctx.gm.filter((x) => x.module_id === mid).map((x) => x.group_id).filter((gid) => gName.has(gid));
    const chip = (text, tone) =>
      `<span class="inline-flex max-w-[12rem] truncate rounded-full px-2 py-0.5 text-[11px] font-medium ${tone}">${esc(text)}</span>`;
    const tags = (mod, gids) =>
      [...gids.map((gid) => chip(gName.get(gid), "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300")),
       ...ctx.companyTags(mod.id).map((c) => chip(c, "bg-sky-50 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300"))].join("");

    const linked = [], unlinked = [];
    ctx.mods.forEach((mod) => {
      const all = bizOf(mod.id);
      const here = all.filter((gid) => myGids.includes(gid));
      (here.length ? linked : unlinked).push({ mod, all, here });
    });

    const linkedRow = ({ mod, here }) => {
      const row = ctx.rows.get(user.id + ":" + mod.id);
      // 用第一个我管得到的 Business 判断能不能勾
      const gidFor = (fn) => here.find((gid) => fn(user, gid, mod.id)) || here[0];
      const accGid = gidFor(ctx.canAccess), admGid = gidFor(ctx.canAdmin);
      const canAdm = ctx.canAdmin(user, admGid, mod.id);
      const canAcc = ctx.canAccess(user, accGid, mod.id) && !(row && row.is_admin && !canAdm);
      const d = mod.code === "DIESEL" && row && canManageModule(mod.id) ? dieselOf(user.id) : null;
      return `<div class="p-3 ${mod.is_active ? "" : "opacity-50"}">
        <div class="flex flex-wrap items-center gap-3">
          ${modLogo(mod, "size-8")}
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-medium">${esc(mod.name)}</p>
            <div class="mt-1 flex flex-wrap gap-1">${tags(mod, here)}</div>
          </div>
          <span class="flex gap-4">
            ${tick(`data-acc="${user.id}:${mod.id}:admin"`, row && row.is_admin, canAdm, ta("admin"))}
            ${tick(`data-acc="${user.id}:${mod.id}:access"`, !!row, canAcc, ta("access"))}
          </span>
        </div>
        ${d ? `<div class="mt-2 ml-11 flex flex-wrap gap-4">${["can_claim", "can_report"].map((k) => tick(`data-diesel="${k}"`, d[k], true, t("diesel." + (k === "can_claim" ? "cashClaims" : "report")))).join("")}</div>` : ""}
      </div>`;
    };

    const unlinkedRow = ({ mod, all }) => {
      const why = all.length ? ta("taggedTo", { biz: all.map((gid) => gName.get(gid)).join(", ") }) : ta("notTagged");
      return `<div class="flex flex-wrap items-center gap-3 p-3 opacity-70">
        ${modLogo(mod, "size-8")}
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-medium">${esc(mod.name)}</p>
          <p class="mt-0.5 text-xs text-slate-500">${esc(why)}</p>
        </div>
        ${isSuper ? `<a href="admin.html#modules" class="text-xs font-semibold text-emerald-700 hover:underline dark:text-emerald-400">${esc(ta("openMaster"))}</a>` : ""}
      </div>`;
    };

    const block = (title, hint, rows, fn) =>
      rows.length
        ? `<div>
            <p class="mb-0.5 text-xs font-bold tracking-wider text-slate-500 uppercase">${esc(title)}</p>
            ${hint ? `<p class="mb-1.5 text-xs text-slate-400">${esc(hint)}</p>` : ""}
            <div class="divide-y divide-slate-200 rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-800">${rows.map(fn).join("")}</div>
          </div>`
        : "";

    if (!ctx.mods.length) return empty(ta("noModules"));
    return `<div class="space-y-4">
      ${myGids.length ? "" : `<div class="${cls.empty}">${esc(ta("noBusiness"))}</div>`}
      ${block(ta("linkedTitle"), "", linked, linkedRow)}
      ${block(ta("unlinkedTitle"), ta("unlinkedHint"), unlinked, unlinkedRow)}
    </div>`;
  }

  // ================================================================ 模块权限（By Module）
  /* 列表：每个模块一行，只显示模块名称（和图示）＋ 它标到的 Company 简称（没有 Company 就显示 Business 名称）。
     点模块 → 详细画面：
       上面下拉选「Business · Company」（模块标到的 Business × 这个 Business 里模块标到的 Company；没有就是「全部 Company」）
       第一区：在这个 Business ＋ Company 里、已经有这个模块的人（Access / Admin 两个勾，规则跟用户资料窗一样）
       第二区：在这个 Business ＋ Company 里、还没有这个模块的人（按钮开 Access）；
               搜寻框也会找不在这里的人（Other users），确认后依序：加进 Business → 加进 Company → 开 Access。 */
  async function accessTab() {
    const seq = routeSeq;
    const ta = (k, v) => t("admin.access." + k, v);
    const [ctx, extra] = await Promise.all([
      loadAccess(),
      Promise.all([
        sb.from("gw_business_companies").select("group_id, company_id"),
        sb.from("gw_member_companies").select("group_id, user_id, company_id"),
      ]).then((r) => r.map((x) => x.data || [])),
    ]);
    if (stale(seq)) return;
    const [bizCos, memberCos] = extra;
    const coById = new Map(ctx.companies.map((c) => [c.id, c]));
    const short = (c) => c.short_name || c.code || c.name;
    const inCompany = (uid, gid, cid) => memberCos.some((x) => x.user_id === uid && x.group_id === gid && x.company_id === cid);
    const locked = (u) => u.id === me.id || u.role === "super_admin";
    // 模块 → 我管得到的 Business（不是 super_admin 只看到自己管得到的模块）
    const byModule = ctx.mods
      .map((mod) => [mod, ctx.groups.filter((g) => ctx.managedPairs.some((p) => p.group_id === g.id && p.module_id === mod.id))])
      .filter(([, gs]) => gs.length);
    // 模块标到的 Company（简称）
    const modCompanies = (mid) => ctx.coTags.filter((x) => x.module_id === mid).map((x) => coById.get(x.company_id)).filter(Boolean);
    // 详细画面的下拉选项：Business × 这个 Business 里模块标到的 Company
    const linesOf = (mod, gs) =>
      gs.flatMap((g) => {
        const cs = modCompanies(mod.id).filter((c) => bizCos.some((x) => x.group_id === g.id && x.company_id === c.id));
        return cs.length ? cs.map((c) => ({ g, c })) : [{ g, c: null }];
      });
    const lineLabel = (l) => l.g.name + " · " + (l.c ? short(l.c) + (short(l.c) !== l.c.name ? ` (${l.c.name})` : "") : ta("allCompanies"));
    const inLine = (u, l) => ctx.inGroup(u.id, l.g.id) && (!l.c || inCompany(u.id, l.g.id, l.c.id));
    const match = (u, q) => !q || [u.full_name, u.email, u.user_code].filter(Boolean).join(" ").toLowerCase().includes(q);
    const byName = (a, b) => (a.full_name || "").localeCompare(b.full_name || "");

    let openMid = null;
    let lineIdx = 0;
    let query = "";
    const cur = () => {
      const [mod, gs] = byModule.find(([m]) => m.id === openMid) || [];
      if (!mod) return null;
      const lines = linesOf(mod, gs);
      if (lineIdx >= lines.length) lineIdx = 0;
      return { mod, lines, line: lines[lineIdx] };
    };

    const person = (u) => `<div class="min-w-0 flex-1">
        <p class="truncate text-sm font-medium">${esc(u.full_name)}${u.status === "disabled" ? ` ${badge(ta("disabled"), "red")}` : ""}</p>
        <p class="truncate text-xs text-slate-500">${esc(u.email)}${u.user_code ? ` · <span class="font-mono">${esc(u.user_code)}</span>` : ""}</p>
      </div>`;
    const avatar = (u) => `<span class="flex size-8 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold dark:bg-slate-700">${esc((u.full_name || "?").slice(0, 1))}</span>`;
    const listBox = (inner, attrs) => `<div ${attrs || ""} class="max-h-72 divide-y divide-slate-100 overflow-y-auto overscroll-contain rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-800">${inner}</div>`;
    const none = (text) => `<p class="px-3 py-6 text-center text-xs text-slate-400">${esc(text)}</p>`;
    const head = (title, n) => `<p class="mb-1.5 flex items-center gap-2 text-xs font-bold tracking-wider text-slate-500 uppercase">${esc(title)}<span class="rounded-full bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold text-slate-500 normal-case dark:bg-slate-800">${n}</span></p>`;

    // ---------------- 列表
    function drawList() {
      view.innerHTML = byModule.length
        ? `<div class="mx-auto max-w-3xl ${cls.card} divide-y divide-slate-100 overflow-hidden dark:divide-slate-800">${byModule
            .map(([mod, gs]) => {
              const cs = modCompanies(mod.id).map(short);
              const tags = cs.length ? cs : gs.map((g) => g.name);
              return `<button data-open-mod="${mod.id}" class="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800/60 ${mod.is_active ? "" : "opacity-50"}">
                ${modLogo(mod, "size-9")}
                <span class="min-w-0 flex-1">
                  <span class="block truncate font-semibold">${esc(mod.name)}</span>
                  <span class="mt-1 flex flex-wrap gap-1">${tags.length ? tags.map((x) => badge(x, cs.length ? "slate" : "blue")).join("") : `<span class="text-xs text-slate-400">—</span>`}</span>
                </span>
                <span class="shrink-0 text-slate-400">${icon("chevron-right", "size-4")}</span>
              </button>`;
            })
            .join("")}</div>`
        : empty(ta("empty"));
      refreshIcons();
    }

    // ---------------- 详细画面
    function drawDetail() {
      const c = cur();
      if (!c) return ((openMid = null), drawList());
      const { mod, lines } = c;
      view.innerHTML = `<div class="mx-auto max-w-3xl space-y-4">
        <div class="${cls.card} space-y-3 p-4">
          <div class="flex items-center gap-3">
            <button data-back class="${btn("ghost", "sm")} -ml-1 shrink-0" aria-label="${esc(ta("back"))}">${icon("arrow-left", "size-4")}<span class="hidden sm:inline">${esc(ta("back"))}</span></button>
            ${modLogo(mod, "size-9")}
            <h3 class="min-w-0 flex-1 truncate text-base font-bold">${esc(mod.name)}</h3>
          </div>
          <label class="block space-y-1.5"><span class="${cls.label}">${esc(ta("line"))}</span>
            <select id="bm-line" class="${cls.input}">${lines.map((l, i) => `<option value="${i}" ${i === lineIdx ? "selected" : ""}>${esc(lineLabel(l))}</option>`).join("")}</select>
          </label>
        </div>
        <div id="bm-s1" class="${cls.card} p-4"></div>
        <div class="${cls.card} space-y-3 p-4">
          <div id="bm-s2-head"></div>
          <div class="relative">
            <span class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400">${icon("search")}</span>
            <input id="bm-q" type="search" value="${esc(query)}" placeholder="${esc(ta("searchPlaceholder"))}" class="${cls.input} pl-9">
          </div>
          <div id="bm-s2"></div>
        </div>
      </div>`;
      drawSections();
    }

    function drawSections() {
      const { mod, line } = cur();
      const mid = mod.id;
      const gid = line.g.id;
      const q = query.trim().toLowerCase();
      const here = ctx.users.filter((u) => inLine(u, line)).sort(byName);
      const has = here.filter((u) => ctx.rows.has(u.id + ":" + mid));
      const not = here.filter((u) => !ctx.rows.has(u.id + ":" + mid));
      // 第一区：Access / Admin 两个勾（跟用户资料窗同一套规则）
      $("#bm-s1").innerHTML = head(ta("hasAccess"), has.length) +
        listBox(
          has
            .map((u) => {
              const row = ctx.rows.get(u.id + ":" + mid);
              const canAdm = ctx.canAdmin(u, gid, mid);
              const canAcc = ctx.canAccess(u, gid, mid) && !(row.is_admin && !canAdm);
              return `<div class="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 ${u.status === "disabled" ? "opacity-60" : ""}">
                ${avatar(u)}${person(u)}
                <span class="flex shrink-0 gap-4">${tick(`data-acc="${u.id}:${mid}:admin"`, row.is_admin, canAdm, ta("admin"))}${tick(`data-acc="${u.id}:${mid}:access"`, true, canAcc, ta("access"))}</span>
              </div>`;
            })
            .join("") || none(ta("nobodyHas")),
          "data-list-has",
        );
      // 第二区：在这里但没有这个模块
      const notShown = not.filter((u) => match(u, q));
      $("#bm-s2-head").innerHTML = head(ta("noAccess"), not.length);
      let html = listBox(
        notShown
          .map((u) => {
            const can = ctx.canGrant(u, gid, mid);
            return `<div class="flex items-center gap-3 px-3 py-2 ${u.status === "disabled" ? "opacity-60" : ""}">
              ${avatar(u)}${person(u)}
              <button data-grant="${u.id}" ${can ? "" : `disabled title="${esc(locked(u) ? ta("lockedReason") : ta("noGrantReason"))}"`} class="${btn("secondary", "sm")} shrink-0">${icon("plus", "size-4")}${esc(ta("giveAccess"))}</button>
            </div>`;
          })
          .join("") || none(ta(q ? "noMatch" : "nobodyWithout")),
        "data-list-not",
      );
      // 搜寻时：也找不在这个 Business / Company 的人（只找启用中的帐号）
      if (q) {
        const others = ctx.users.filter((u) => u.status === "active" && !inLine(u, line) && match(u, q)).sort(byName);
        const canAddBiz = me.bizCan(gid, "can_add_business_user");
        html += `<div class="pt-1">${head(ta("otherUsers"), others.length)}<p class="mb-1.5 text-xs text-slate-400">${esc(ta("otherHint"))}</p>${listBox(
          others
            .map((u) => {
              const why = locked(u) ? ta("lockedReason") : !canAddBiz ? ta("noBusinessReason") : !ctx.canGrant(u, gid, mid) ? ta("noGrantReason") : "";
              return `<div class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                ${avatar(u)}${person(u)}
                <button data-outsider="${u.id}" ${why ? "disabled" : ""} class="${btn("secondary", "sm")} shrink-0">${icon("user-plus", "size-4")}${esc(ta("addOutsider"))}</button>
                ${why ? `<p class="w-full pl-11 text-xs text-amber-600 dark:text-amber-400">${esc(why)}</p>` : ""}
              </div>`;
            })
            .join("") || none(ta("noOthers")),
          "data-list-other",
        )}</div>`;
      }
      $("#bm-s2").innerHTML = html;
      refreshIcons();
    }

    // 加不在这个 Business / Company 的人：先确认，再依序 Business → Company → 模块 Access
    async function addOutsider(uid) {
      const { mod, line } = cur();
      const u = ctx.users.find((x) => x.id === uid);
      const g = line.g, c = line.c;
      const row = (k, v) => `<div class="flex gap-3 py-1.5"><dt class="w-24 shrink-0 text-slate-500">${esc(k)}</dt><dd class="min-w-0 flex-1 font-medium break-words">${v}</dd></div>`;
      const ok = await new Promise((resolve) => {
        let answered = false;
        const m = modal(
          ta("confirmTitle"),
          `<p class="mb-3 text-sm text-slate-600 dark:text-slate-300">${esc(ta("confirmBody"))}</p>
           <dl class="mb-5 divide-y divide-slate-100 rounded-xl border border-slate-200 px-3 text-sm dark:divide-slate-800 dark:border-slate-800">
             ${row(ta("user"), `${esc(u.full_name)}<span class="block text-xs font-normal text-slate-500">${esc(u.email)}</span>`)}
             ${row(ta("business"), esc(g.name))}
             ${row(ta("company"), esc(c ? c.name : ta("allCompanies")))}
             ${row(ta("module"), esc(mod.name))}
           </dl>
           <div class="flex justify-end gap-2">
             <button data-no class="${btn("secondary")}">${esc(ta("cancel"))}</button>
             <button data-yes class="${btn("primary")}">${esc(ta("confirmAdd"))}</button>
           </div>`,
          { onClose: () => !answered && resolve(false) },
        );
        m.el.querySelector("[data-no]").onclick = () => m.close();
        m.el.querySelector("[data-yes]").onclick = () => ((answered = true), m.close(), resolve(true));
      });
      if (!ok) return;
      // 1. 加进 Business（跟 Group Manage 拖拉同一个写法）
      if (!ctx.inGroup(uid, g.id)) {
        const { error } = await sb.from("gw_group_members").insert({ group_id: g.id, user_id: uid });
        if (error) return (toast(ta("addBusinessFailed")), drawSections());
        ctx.members.push({ group_id: g.id, user_id: uid });
      }
      // 2. 加进这个 Business 里的 Company
      if (c && !inCompany(uid, g.id, c.id)) {
        const { error } = await sb.from("gw_member_companies").insert({ group_id: g.id, user_id: uid, company_id: c.id });
        if (error) return (toast(ta("addCompanyFailed", { biz: g.name })), drawSections());
        memberCos.push({ group_id: g.id, user_id: uid, company_id: c.id });
      }
      // 3. 开模块 Access
      if (!ctx.rows.has(uid + ":" + mod.id) && !(await saveAccess(ctx, uid, mod.id, true, false))) {
        toast(ta("grantAfterAddFailed", { place: c ? g.name + " · " + c.name : g.name }));
        return drawSections();
      }
      toast(ta("outsiderAdded", { name: u.full_name, module: mod.name }));
      drawSections();
    }

    view.onclick = async (e) => {
      const b = e.target.closest("button");
      if (!b || b.disabled) return;
      if (b.dataset.openMod) return ((openMid = b.dataset.openMod), (lineIdx = 0), (query = ""), drawDetail(), scrollTo(0, 0));
      if ("back" in b.dataset) return ((openMid = null), drawList());
      if (b.dataset.grant) {
        b.disabled = true;
        await saveAccess(ctx, b.dataset.grant, openMid, true, false);
        return drawSections();
      }
      if (b.dataset.outsider) return addOutsider(b.dataset.outsider);
    };
    view.onchange = async (e) => {
      if (e.target.id === "bm-line") return ((lineIdx = Number(e.target.value) || 0), drawSections());
      await onTick(ctx, e, drawSections);
    };
    view.oninput = (e) => {
      if (e.target.id !== "bm-q") return;
      query = e.target.value;
      drawSections();
    };
    drawList();
  }

  // ---------------------------------------------------------------- 模块小图示、用户资料窗（用户名单、群组管理共用）
  const modLogo = (m, size) =>
    m.image_url
      ? `<img src="${esc(m.image_url)}" alt="${esc(m.name)}" title="${esc(m.name)}" class="${size || "size-5"} shrink-0 rounded-md object-cover">`
      : `<span title="${esc(m.name)}" class="flex ${size || "size-5"} shrink-0 items-center justify-center rounded-md bg-brand-50 text-brand-600 dark:bg-brand-700/20 dark:text-brand-100">${moduleIcon(m.icon, "size-3")}</span>`;
  // 我能不能管理某模块里的用户权限（super_admin、模块 Admin、角色有「管理模块用户权限」）
  const canManageModule = (mid) => isSuper || (me.adminModuleIds || []).includes(mid) || (C.can_manage_module_access && (me.roleModules || []).includes(mid));

  /* 用户资料窗：名字、代码、Business / Company，和他可以用的模块（只读）。
     右上角 X 左边的铅笔 = 编辑模式：可以改他的模块权限（Access / Admin，Diesel 还有 Cash Claim / Report）。
     能不能进编辑模式看角色：super_admin、角色有加 / 移除 / 设定 Admin 的 Business、或是模块 Admin。 */
  async function userWindow(uid, onClose) {
    const tu = (k, v) => t("admin.userWindow." + k, v);
    const m = modal("", GW.spinner(), { wide: true, onClose });
    const [{ data: u }, { data: mems }, { data: groups }, { data: companies }, { data: mm }, { data: mods }, { data: gxRows }, { data: mcs }] = await Promise.all([
      sb.from("gw_profiles").select("id, full_name, email, status, role, role_id, user_code").eq("id", uid).maybeSingle(),
      sb.from("gw_group_members").select("group_id").eq("user_id", uid),
      sb.from("gw_groups").select("id, name").order("sort_order").order("name"),
      sb.from("gw_companies").select("id, name"),
      sb.from("gw_module_members").select("user_id, module_id, is_admin").eq("user_id", uid),
      sb.from("gw_modules").select("id, code, name, icon, image_url, is_active").order("sort_order").order("name"),
      sb.from("gw_group_modules").select("group_id, module_id"),
      sb.from("gw_member_companies").select("group_id, company_id").eq("user_id", uid),
    ]);
    if (!u) return m.close();
    const h = m.el.parentElement.querySelector("h2");
    if (h) h.textContent = u.full_name;
    const gName = new Map((groups || []).map((g) => [g.id, g.name])), cName = new Map((companies || []).map((c) => [c.id, c.name]));
    const modById = new Map((mods || []).map((x) => [x.id, x]));
    let mine = (mm || []).filter((r) => modById.has(r.module_id));
    const myGroups = (mems || []).map((x) => x.group_id);
    const locked = u.id === me.id || u.role === "super_admin";
    const canEdit =
      !locked &&
      (isSuper ||
        myGroups.some((gid) => ["can_grant_module", "can_revoke_module", "can_set_module_admin"].some((f) => me.bizCan(gid, f))) ||
        (gxRows || []).some((g) => myGroups.includes(g.group_id) && canManageModule(g.module_id)) ||
        (me.adminModuleIds || []).some((mid) => (gxRows || []).some((g) => myGroups.includes(g.group_id) && g.module_id === mid)));
    // 点名字就直接显示全部模块和 Access / Admin 勾选（不用再按铅笔）
    const editing = true;
    let ctx = null;
    let diesel = null; // 这个人在 Diesel 里的 Cash Claim / Report
    let open = null; // 正在看的模块（只读模式）

    async function detail(mid) {
      const mod = modById.get(mid);
      const row = mine.find((r) => r.module_id === mid);
      const box = $("[data-detail]", m.el);
      let extra = "";
      if (mod.code === "DIESEL" && row && canManageModule(mid)) {
        const { data: ua } = await sb.from("diesel_user_access").select("can_claim, can_report").eq("user_id", uid).maybeSingle();
        const d = ua || { can_claim: false, can_report: false };
        extra = ["can_claim", "can_report"]
          .map((k) => `<label class="flex items-center gap-2 text-sm"><input type="checkbox" disabled ${d[k] ? "checked" : ""} class="size-4 accent-emerald-600">${esc(t("diesel." + (k === "can_claim" ? "cashClaims" : "report")))}</label>`)
          .join("");
      }
      box.innerHTML = `<div class="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
        <div class="mb-2 flex items-center gap-2">${modLogo(mod, "size-7")}<span class="font-semibold">${esc(mod.name)}</span></div>
        <div class="grid gap-2 sm:grid-cols-2">
          <label class="flex items-center gap-2 text-sm"><input type="checkbox" disabled ${row ? "checked" : ""} class="size-4 accent-emerald-600">${esc(t("admin.users.accessDialog.access"))}</label>
          <label class="flex items-center gap-2 text-sm"><input type="checkbox" disabled ${row && row.is_admin ? "checked" : ""} class="size-4 accent-emerald-600">${esc(t("admin.users.accessDialog.admin"))}</label>
          ${extra}
        </div>
      </div>`;
    }

    async function draw() {
      const head = `<div class="flex items-start gap-3">
          <span class="flex size-11 shrink-0 items-center justify-center rounded-full bg-slate-200 text-base font-semibold dark:bg-slate-700">${esc(u.full_name.slice(0, 1))}</span>
          <div class="min-w-0 flex-1">
            <p class="text-sm text-slate-500">${esc(u.email)}${u.user_code ? ` · <span class="font-mono">${esc(u.user_code)}</span>` : ""}</p>
            <div class="mt-1.5 space-y-1">${
              (mems || [])
                .map((x) => {
                  const cs = (mcs || []).filter((y) => y.group_id === x.group_id).map((y) => cName.get(y.company_id)).filter(Boolean);
                  return `<div class="flex flex-wrap items-center gap-1">${badge(gName.get(x.group_id) || "", "blue")}${cs.length ? cs.map((c) => badge(c)).join("") : badge(tu("noCompany"), "amber")}</div>`;
                })
                .join("") || `<span class="text-xs text-slate-400">${esc(tu("noBusiness"))}</span>`
            }</div>
          </div>
        </div>`;
      if (editing) {
        const note = locked ? tu(u.id === me.id ? "selfNote" : "superNote") : !canEdit ? tu("viewOnlyNote") : "";
        m.el.innerHTML = `<div class="space-y-4">${head}${note ? `<p class="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">${esc(note)}</p>` : ""}${ctx ? accessSections(ctx, u, () => diesel || { can_claim: false, can_report: false }) : GW.spinner()}
          <div class="flex justify-end"><button data-done class="${btn("primary")}">${esc(t("admin.users.done"))}</button></div></div>`;
        refreshIcons();
        return;
      }
      m.el.innerHTML = `<div class="space-y-4">
        ${head}
        <div>
          <p class="mb-1.5 text-[11px] font-bold tracking-wider text-slate-500 uppercase">${esc(tu("modules"))}</p>
          ${
            mine.length
              ? `<div class="flex flex-wrap gap-2">${mine
                  .map((r) => {
                    const mod = modById.get(r.module_id);
                    return `<button data-mod="${mod.id}" class="flex items-center gap-2 rounded-xl border px-3 py-2 text-sm ${open === mod.id ? "border-brand-500 bg-brand-50 dark:bg-brand-700/20" : "border-slate-200 dark:border-slate-800"}">${modLogo(mod, "size-6")}<span>${esc(mod.name)}</span>${r.is_admin ? badge("Admin", "amber") : ""}</button>`;
                  })
                  .join("")}</div>`
              : `<p class="text-sm text-slate-400">${esc(tu("noModules"))}</p>`
          }
        </div>
        <div data-detail></div>
        <div class="flex justify-end"><button data-done class="${btn("primary")}">${esc(t("admin.users.done"))}</button></div>
      </div>`;
      refreshIcons();
      if (open) detail(open);
    }

    m.el.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if ("done" in b.dataset) return m.close();
      if (b.dataset.mod) ((open = b.dataset.mod), draw());
    });
    m.el.addEventListener("change", async (e) => {
      const box = e.target;
      if (box.dataset.diesel) {
        box.disabled = true;
        const next = { user_id: uid, can_claim: !!diesel.can_claim, can_report: !!diesel.can_report, updated_by: me.id, updated_at: new Date().toISOString() };
        next[box.dataset.diesel] = box.checked;
        const { error } = await sb.from("diesel_user_access").upsert(next);
        if (error) toast(t("admin.users.accessDialog.saveFailed"));
        else diesel[box.dataset.diesel] = box.checked;
        return draw();
      }
      await onTick(ctx, e, () => {
        mine = [...ctx.rows.values()].filter((r) => r.user_id === uid && modById.has(r.module_id));
        draw();
      });
    });
    draw();
    ctx = await loadAccess();
    const { data: ua } = await sb.from("diesel_user_access").select("can_claim, can_report").eq("user_id", uid).maybeSingle();
    diesel = ua || { can_claim: false, can_report: false };
    draw();
  }


  // ================================================================ 用户名单（super_admin 可以管理；角色有「看名单」只能看，而且只看得到它负责的 Business 的人）
  async function usersTab() {
    const seq = routeSeq;
    const tu = (k, v) => t("admin.users." + k, v);
    const [users, groups, members, roles, mods, mm, companies, bizCo] = await Promise.all([
      sb.from("gw_profiles").select("*").order("full_name"),
      sb.from("gw_groups").select("*").order("sort_order").order("name"),
      sb.from("gw_group_members").select("group_id, user_id"),
      sb.from("gw_roles").select("id, name").order("sort_order").order("name"),
      sb.from("gw_modules").select("id, code, name, icon, image_url").order("sort_order").order("name"),
      sb.from("gw_module_members").select("user_id, module_id, is_admin"),
      sb.from("gw_companies").select("id, name").order("sort_order").order("name"),
      sb.from("gw_business_companies").select("group_id, company_id"),
    ]).then((r) => r.map((x) => x.data || []));
    const groupName = new Map(groups.map((g) => [g.id, g.name]));
    const modById = new Map(mods.map((x) => [x.id, x]));
    const modsOf = (uid) => mm.filter((r) => r.user_id === uid && modById.has(r.module_id));
    const roleName = new Map(roles.map((r) => [r.id, r.name]));
    const groupsOf = (id) => members.filter((m) => m.user_id === id).map((m) => m.group_id);
    // 角色下拉：一般用户 / 各自订角色 / Super Admin（值 = "user" | 角色 id | "super_admin"）
    const roleValue = (u) => (u.role === "super_admin" ? "super_admin" : u.role_id || "user");
    const roleBadge = (u) => (u.role === "super_admin" ? badge(tu("roles.super_admin"), "red") : u.role_id ? badge(roleName.get(u.role_id) || tu("roles.user"), "amber") : badge(tu("roles.user")));
    const roleOptions = [["user", tu("roles.user")], ...roles.map((r) => [r.id, r.name]), ["super_admin", tu("roles.super_admin")]];
    const toRole = (v) => (v === "super_admin" ? { role: "super_admin", role_id: null } : v === "user" ? { role: "user", role_id: null } : { role: "user", role_id: v });
    const filter = { q: "", role: "", status: "", module: "" };

    if (stale(seq)) return;
    view.innerHTML = `<div class="space-y-4">
      <div class="flex flex-col gap-2 lg:flex-row">
        ${searchBox("q", tu("search"))}
        <div class="grid grid-cols-2 gap-2 lg:flex">
          <select id="module-filter" class="${cls.input} lg:w-44"><option value="">${esc(tu("allModules"))}</option>${mods.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join("")}</select>
          <select id="role-filter" class="${cls.input} lg:w-40"><option value="">${esc(tu("allRoles"))}</option>${roleOptions.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("")}</select>
          <select id="status" class="${cls.input} lg:w-32">
            <option value="">${esc(tu("allStatus"))}</option>
            <option value="active">${esc(tu("status.active"))}</option>
            <option value="disabled">${esc(tu("status.disabled"))}</option>
          </select>
          ${isSuper ? `<button id="import" class="${btn("secondary")}">${icon("upload")} ${esc(tu("import.button"))}</button>
          <button id="add" class="${btn("primary")}">${icon("user-plus")} ${esc(tu("add"))}</button>` : ""}
        </div>
      </div>
      <div id="list"></div>
    </div>`;

    function drawList() {
      const q = filter.q.trim().toLowerCase();
      const list = users.filter(
        (u) =>
          (!q || u.full_name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q) || (u.user_code || "").toLowerCase().includes(q)) &&
          (!filter.role || roleValue(u) === filter.role) &&
          (!filter.status || u.status === filter.status) &&
          (!filter.module || modsOf(u.id).some((r) => r.module_id === filter.module)),
      );
      $("#list").innerHTML = list.length
        ? `<div class="${cls.card} divide-y divide-slate-200 dark:divide-slate-800">${list
            .map(
              (u) => `<div class="flex flex-col gap-3 p-4 md:flex-row md:items-center">
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-2">
                    ${roleBadge(u)}
                    <button data-window="${u.id}" class="font-medium hover:underline">${esc(u.full_name)}</button>
                    <span class="font-mono text-xs text-slate-400">${esc(u.user_code || "")}</span>
                    ${u.status === "disabled" ? badge(tu("status.disabled"), "red") : ""}
                    ${u.must_change_password ? badge(tu("mustChange")) : ""}
                  </div>
                  ${modsOf(u.id).length ? `<div class="mt-1.5 flex flex-wrap gap-1">${modsOf(u.id).map((r) => modLogo(modById.get(r.module_id), "size-5")).join("")}</div>` : ""}
                </div>
                <div class="flex flex-wrap gap-1.5">
                  <button data-window="${u.id}" class="${btn("ghost", "sm")}">${icon("id-card")} ${esc(tu("details"))}</button>
                  ${
                    isSuper
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
      const selected = new Set(user ? groupsOf(user.id) : []);
      const companiesIn = (gid) => companies.filter((c) => bizCo.some((l) => l.group_id === gid && l.company_id === c.id));
      const m = modal(
        user ? tu("editTitle") : tu("addTitle"),
        `<form class="space-y-4">
          <div data-err></div>
          ${field(tu("name"), `<input name="full_name" required value="${esc(user ? user.full_name : "")}" class="${cls.input}">`)}
          ${field("Email", `<input name="email" type="email" required value="${esc(user ? user.email : "")}" ${user ? "disabled" : ""} class="${cls.input}">`)}
          ${
            user
              ? `<div>
                  <p class="mb-1.5 ${cls.label}">${esc(tu("groups"))}</p>
                  ${
                    groups.length
                      ? `<div class="flex flex-wrap gap-2">${groups.map((g) => `<button type="button" data-group="${g.id}" class="rounded-full border px-3 py-1 text-sm">${esc(g.name)}</button>`).join("")}</div>`
                      : `<p class="text-sm text-slate-500">${esc(tu("noGroups"))}</p>`
                  }
                </div>`
              : `<div class="grid gap-4 sm:grid-cols-2">
                  ${field(t("admin.tabs.business"), select("business", [["", "—"], ...groups.map((g) => [g.id, g.name])], ""))}
                  ${field(t("admin.tabs.company"), select("company", [["", "—"]], ""))}
                </div>`
          }
          ${field(tu("role"), select("role", roleOptions, user ? roleValue(user) : "user", user && user.id === me.id ? "disabled" : ""))}
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
      // 新增用户：选了 Business，Company 才有得选（只列这个 Business 的 Company）
      if (!user) {
        const f0 = $("form", m.el);
        f0.business.addEventListener("change", () => {
          const list = companiesIn(f0.business.value);
          f0.company.innerHTML = [["", "—"], ...list.map((c) => [c.id, c.name])].map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("");
        });
      }
      $("[data-cancel]", m.el).onclick = m.close;
      $("form", m.el).addEventListener("submit", async (e) => {
        e.preventDefault();
        const f = e.target;
        const submit = $("button[type=submit]", f);
        submit.disabled = true;
        if (!user) selected.clear();
        if (!user && f.business.value) selected.add(f.business.value);
        const input = { full_name: f.full_name.value.trim(), ...toRole(f.role.disabled ? roleValue(user) : f.role.value), group_ids: [...selected] };
        const r = user ? await updateUser(user.id, input) : await invoke("gw-admin", { action: "create_user", user: { ...input, email: f.email.value.trim() } });
        // 新用户：把 Company 补上（建立用户的功能只收 Business）
        if (!user && r && r.ok && f.business.value && f.company.value) {
          const { data: created } = await sb.from("gw_profiles").select("id").eq("email", r.email).maybeSingle();
          if (created) await sb.from("gw_member_companies").insert({ group_id: f.business.value, user_id: created.id, company_id: f.company.value });
        }
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
    $("#module-filter").addEventListener("change", (e) => ((filter.module = e.target.value), drawList()));
    $("#status").addEventListener("change", (e) => ((filter.status = e.target.value), drawList()));
    if (isSuper) {
      $("#add").onclick = () => userDialog(null);
      $("#import").onclick = importDialog;
    }
    $("#list").addEventListener("click", async (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.window) return userWindow(b.dataset.window);
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

  /* User Group Manage（只限 super_admin）
     左边：还没有任何群组的人（Pending assignment），拖到右边的群组卡片就加入；手机可点名字选群组。
     右边：每个群组一张卡片：成员（× 移出）＋ Group Access（这个群组能看到哪些 App）。 */
  // ================================================================ 群组列表（User & Group Manage）
  // Business（gw_groups）→ Company（gw_companies，经由 gw_business_companies 连结）；把左边的人拖进某个 Business 底下的某个 Company
  async function groupsTab() {
    const seq = routeSeq;
    const tg = (k, v) => t("admin.groups." + k, v);
    const tu2 = (k, v) => t("admin.userGroups." + k, v);
    const [allGroups, users, members, memberCos, companies, grantRows, links, mods, mm] = await Promise.all([
      sb.from("gw_groups").select("*").order("sort_order").order("name"),
      sb.from("gw_profiles").select("id, full_name, email, status, role").order("full_name"),
      sb.from("gw_group_members").select("group_id, user_id"),
      sb.from("gw_member_companies").select("group_id, user_id, company_id"),
      sb.from("gw_companies").select("*").eq("is_active", true).order("sort_order").order("name"),
      sb.from("gw_group_modules").select("group_id, module_id"),
      sb.from("gw_business_companies").select("group_id, company_id"),
      sb.from("gw_modules").select("id, code, name, icon, image_url").order("sort_order").order("name"),
      sb.from("gw_module_members").select("user_id, module_id"),
    ]).then((r) => r.map((x) => (Array.isArray(x) ? x : x.data || [])));
    if (stale(seq)) return;
    const modById = new Map(mods.map((x) => [x.id, x]));
    // 这个人在这个 Business 里可以用的模块（小图示）
    const logosIn = (uid, gid) =>
      mm
        .filter((r) => r.user_id === uid && modById.has(r.module_id) && grantRows.some((g) => g.group_id === gid && g.module_id === r.module_id))
        .map((r) => modLogo(modById.get(r.module_id), "size-4"))
        .join("");

    // 角色功能：加人（拖拉、点名字）、移出、模块权限
    const canAdd = isSuper || C.can_add_business_user; // 任一 Business 可以加人 → 显示左边名单
    const canAddTo = (gid) => me.bizCan(gid, "can_add_business_user");
    const canRemoveFrom = (gid) => me.bizCan(gid, "can_remove_business_user");
    // 角色只看到自己管的 Business（自己是成员的其他 Business 不能在这里管）
    const groups = allGroups.filter((g) => isSuper || (me.businessIds || []).includes(g.id));
    const userById = new Map(users.map((u) => [u.id, u]));
    const memberSet = new Set(members.map((m) => m.group_id + ":" + m.user_id));
    // "Business:用户" → 这个人在这个 Business 里的 Company（可以有好几个；一个都没有 = 还没分到 Company）
    const coMap = new Map();
    memberCos.forEach((x) => {
      const k = x.group_id + ":" + x.user_id;
      if (!coMap.has(k)) coMap.set(k, new Set());
      coMap.get(k).add(x.company_id);
    });
    const cosOf = (gid, uid) => coMap.get(gid + ":" + uid) || new Set();
    let query = "";
    let activeGid = null;
    try {
      activeGid = localStorage.getItem("gw_ug_business");
    } catch (e) {
      /* 忽略 */
    }
    if (!groups.some((g) => g.id === activeGid)) activeGid = groups.length ? groups[0].id : null;
    let sortables = [];
    const groupsOf = (uid) => groups.filter((g) => memberSet.has(g.id + ":" + uid));
    const companiesOf = (gid) => companies.filter((c) => links.some((l) => l.group_id === gid && l.company_id === c.id));

    const ROW = "h-[3.25rem]";
    // 名片：Business 里只显示名字（下面是他可以用的模块小图示）；左边待分配名单显示名字和 Email
    const chip = (u, extra, gid) => `<div data-user="${u.id}" class="gw-user ${gid ? ROW + " mb-1.5" : ""} flex ${canAdd ? "cursor-grab" : "cursor-pointer"} items-center gap-2 rounded-xl border border-white/70 bg-white/80 px-2.5 py-1.5 text-sm shadow-sm dark:border-slate-700 dark:bg-slate-800 ${u.status === "disabled" ? "opacity-50" : ""}">
        <span class="flex size-7 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold dark:bg-slate-700">${esc(u.full_name.slice(0, 1))}</span>
        <span class="min-w-0 flex-1"><span class="block truncate font-medium">${esc(u.full_name)}</span>${gid ? `<span class="mt-0.5 flex flex-wrap gap-1">${logosIn(u.id, gid)}</span>` : `<span class="block truncate text-xs text-slate-500">${esc(u.email)}</span>`}</span>
        ${extra || ""}
      </div>`;
    const spacer = `<div class="gw-spacer ${ROW} mb-1.5"></div>`;

    // 一个 Company 的一栏：每个人固定一行，没在这个 Company 的留空白，所以同一个人在不同 Company 会排在同一行
    function column(g, c, rowUsers) {
      const mine = rowUsers.filter((u) => (c ? cosOf(g.id, u.id).has(c.id) : cosOf(g.id, u.id).size === 0));
      const items = rowUsers
        .map((u) => {
          if (!mine.includes(u)) return spacer;
          const x = c
            ? canAddTo(g.id) || canRemoveFrom(g.id)
              ? `<button data-out="${g.id}:${u.id}:${c.id}" aria-label="${esc(tu2("removeFromCompany"))}" title="${esc(tu2("removeFromCompany"))}" class="no-drag rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600">${icon("x")}</button>`
              : ""
            : canRemoveFrom(g.id)
              ? `<button data-out-biz="${g.id}:${u.id}" aria-label="${esc(tu2("removeMember"))}" title="${esc(tu2("removeMember"))}" class="no-drag rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600">${icon("x")}</button>`
              : "";
          return chip(u, x, g.id);
        })
        .join("");
      return `<div class="w-64 shrink-0">
        <div class="sticky top-0 z-10 -mx-1 mb-2 rounded-xl bg-white/80 px-3 py-2 backdrop-blur dark:bg-slate-900/80">
          <p class="flex items-center gap-1.5 truncate text-sm font-semibold ${c ? "text-slate-800 dark:text-slate-100" : "text-amber-600"}">${icon(c ? "building-2" : "circle-dashed", "size-4 shrink-0")}${c ? `<button data-info="${c.id}" data-from="${g.id}" class="truncate hover:underline">${esc(c.name)}</button>` : esc(tu2("pendingCompany"))}</p>
        </div>
        <div ${canAddTo(g.id) ? `data-drop="${g.id}"` : ""} data-company="${c ? c.id : ""}" class="${canAddTo(g.id) ? "gw-drop" : ""} min-h-24 rounded-xl border-2 border-dashed border-slate-200/80 p-1.5 dark:border-slate-700">${items || `<p class="py-4 text-center text-xs text-slate-400">${esc(tu2("dropHere"))}</p>`}</div>
      </div>`;
    }

    function draw() {
      sortables.forEach((x) => x.destroy());
      sortables = [];
      const pending = users.filter((u) => u.status === "active" && u.role !== "super_admin" && groupsOf(u.id).length === 0);
      const q = query.trim().toLowerCase();
      const leftList = pending.filter((u) => !q || (u.full_name + " " + u.email).toLowerCase().includes(q));
      const g = groups.find((x) => x.id === activeGid);
      // 这个 Business 的所有成员（按名字排），每个 Company 一栏都用同样的顺序
      const rowUsers = g ? users.filter((u) => memberSet.has(g.id + ":" + u.id)).sort((a, b) => a.full_name.localeCompare(b.full_name)) : [];
      const comps = g ? companiesOf(g.id) : [];

      view.innerHTML = `<div class="flex flex-col gap-4 lg:flex-row">
        <aside class="w-full shrink-0 space-y-3 self-start lg:sticky lg:top-20 lg:w-64">
          <div class="${cls.card} p-2">
            <div class="flex flex-wrap gap-1 lg:flex-col">${
              groups.length
                ? groups.map((x) => `<button data-tab="${x.id}" class="truncate rounded-lg px-3 py-2 text-left text-sm font-medium ${x.id === activeGid ? "bg-slate-900 text-white dark:bg-white dark:text-slate-900" : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"}">${esc(x.name)}</button>`).join("")
                : `<p class="px-3 py-2 text-sm text-slate-400">${esc(tu2("noBusiness"))}</p>`
            }</div>
          </div>
          ${
            canAdd
              ? `<div class="${cls.card} p-3">
                  <p class="mb-2 text-xs font-bold tracking-wider text-amber-600 uppercase">${esc(tu2("pending"))}</p>
                  <input id="ug-q" type="search" value="${esc(query)}" placeholder="${esc(t("admin.users.search"))}" class="${cls.input} mb-2 h-9">
                  <div id="ug-left" class="max-h-[45vh] space-y-1.5 overflow-y-auto">${
                    leftList.length ? leftList.map((u) => chip(u, "")).join("") : `<p class="py-6 text-center text-sm text-slate-400">${esc(tu2("pendingEmpty"))}</p>`
                  }</div>
                </div>`
              : ""
          }
        </aside>
        <section class="${cls.card} min-w-0 flex-1 p-3">
          ${
            g
              ? `<h3 class="mb-3 px-1 text-base font-bold">${esc(g.name)}</h3>
                 <div id="ug-scroll" class="max-h-[72vh] overflow-auto rounded-xl">
                   <div class="flex min-w-max items-start gap-3 pb-2">
                     ${comps.map((c) => column(g, c, rowUsers)).join("")}${column(g, null, rowUsers)}
                   </div>
                 </div>
                 ${comps.length ? "" : `<p class="mt-2 text-xs text-slate-400">${esc(tu2("noCompanies"))} <a href="#company" class="underline">${esc(t("admin.tabs.company"))}</a></p>`}`
              : `<div class="${cls.empty}">${esc(tu2("noBusiness"))} <a href="#business" class="font-medium underline">${esc(t("admin.sections.master"))} → ${esc(t("admin.tabs.business"))}</a></div>`
          }
        </section>
      </div>`;
      refreshIcons();

      // 拖拉：左边待分配的人 → 某个 Company 的一栏；Company 之间拖 = 也加进那个 Company（原来的还在）；没有「加人」功能就只能看
      if (!canAdd) return;
      if ($("#ug-left"))
        sortables.push(window.Sortable.create($("#ug-left"), { group: { name: "ug", pull: "clone", put: false }, sort: false, delay: 200, delayOnTouchOnly: true, filter: ".no-drag", animation: 150 }));
      $$(".gw-drop").forEach((el) =>
        sortables.push(
          window.Sortable.create(el, {
            group: { name: "ug", pull: "clone", put: true },
            sort: false,
            delay: 200,
            delayOnTouchOnly: true,
            animation: 150,
            filter: ".no-drag, .gw-spacer",
            onAdd: (evt) => {
              const uid = evt.item.dataset.user;
              const fromCo = evt.from && evt.from.dataset ? evt.from.dataset.company || null : null;
              evt.item.remove();
              place(el.dataset.drop, el.dataset.company || null, uid, fromCo);
            },
          }),
        ),
      );
      $("#ug-q")?.addEventListener("input", (e) => {
        query = e.target.value;
        const pos = e.target.selectionStart;
        draw();
        const input = $("#ug-q");
        input.focus();
        input.setSelectionRange(pos, pos);
      });
    }

    // 放进某个 Business 的某个 Company：还不是 Business 成员就先加进 Business；拖到「Pending allocation」栏 = 从原来的 Company 拿掉
    async function place(gid, cid, uid, fromCo) {
      const key = gid + ":" + uid;
      const g = groups.find((x) => x.id === gid);
      const c = companies.find((x) => x.id === cid);
      if (!cid && fromCo) return removeCompany(gid, uid, fromCo);
      if (!memberSet.has(key)) {
        const { error } = await sb.from("gw_group_members").insert({ group_id: gid, user_id: uid });
        if (error) return draw(), setMsg(tg("saveFailed"));
        memberSet.add(key);
      }
      if (cid) {
        if (cosOf(gid, uid).has(cid)) return draw(), toast(tu2("alreadyMember"));
        const { error } = await sb.from("gw_member_companies").insert({ group_id: gid, user_id: uid, company_id: cid });
        if (error) return draw(), setMsg(tg("saveFailed"));
        if (!coMap.has(key)) coMap.set(key, new Set());
        coMap.get(key).add(cid);
      }
      toast(tu2("added", { name: userById.get(uid).email, group: c ? g.name + " · " + c.name : g.name }));
      draw();
    }
    // 从某个 Company 拿掉（人还在 Business 里；一个 Company 都没有就回到「Pending allocation to company」）
    async function removeCompany(gid, uid, cid) {
      const { error } = await sb.from("gw_member_companies").delete().eq("group_id", gid).eq("user_id", uid).eq("company_id", cid);
      if (error) return draw(), setMsg(tg("saveFailed"));
      cosOf(gid, uid).delete(cid);
      draw();
    }

    // 手机：点名字选 Business → Company
    function pick(uid) {
      const u = userById.get(uid);
      const m = modal(
        tu2("addToGroup", { name: u.email }),
        groups.filter((g) => canAddTo(g.id)).length
          ? `<div class="space-y-4">${groups
              .filter((g) => canAddTo(g.id))
              .map((g) => {
                const opts = [...companiesOf(g.id).map((c) => [c.id, c.name]), ...(companiesOf(g.id).length ? [] : [["", tu2("noCompany")]])];
                return `<div><p class="mb-1.5 text-xs font-bold tracking-wider text-slate-500 uppercase">${esc(g.name)}</p><div class="space-y-1.5">${opts
                  .map(([cid, label]) => {
                    const here = cid ? cosOf(g.id, uid).has(cid) : memberSet.has(g.id + ":" + uid);
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
      if (d.tab) {
        activeGid = d.tab;
        try {
          localStorage.setItem("gw_ug_business", activeGid);
        } catch (err) {
          /* 忽略 */
        }
        return draw();
      }
      if (d.info) return companyInfo(d.info, d.from || null);
      if (d.out) {
        const [gid, uid, cid] = d.out.split(":");
        return removeCompany(gid, uid, cid);
      }
      if (d.outBiz) {
        const [gid, uid] = d.outBiz.split(":");
        const { error } = await sb.from("gw_group_members").delete().eq("group_id", gid).eq("user_id", uid);
        if (error) return setMsg(tg("saveFailed"));
        memberSet.delete(gid + ":" + uid);
        coMap.delete(gid + ":" + uid);
        return draw();
      }
      // 左边名单点名字：选 Business / Company（手机不方便拖拉时用）；Business 里点名字：看他的资料、所属 Company 和模块权限
      if (d.user && !e.target.closest(".no-drag")) return b.closest("#ug-left") ? (canAdd ? pick(d.user) : null) : userWindow(d.user, () => groupsTab());
    };
    draw();
  }

  // ================================================================ 角色（Master Manage；super_admin 命名角色，按 Business 勾功能）
  /* 弹出视窗：
       名称、说明
       Notice Board：每个 Business 勾「更新 / 删除」
       Module（全域，范围 = 负责的 Business 里的模块）：管理模块内用户权限、改模块名称
       User & Group Manage：勾了才出现 Business 列表；每个 Business 勾：加人进模块、移除、设定模块 Admin、加人进 Business、移出、看全部用户名单
         （勾了任何一项就自动算有 User & Group Manage）
       View audit log */
  async function rolesTab() {
    const seq = routeSeq;
    const tr = (k, v) => t("admin.roles." + k, v);
    const tg = (k, v) => t("admin.groups." + k, v);
    const [roles, rb, groups] = await Promise.all([
      sb.from("gw_roles").select("*").order("sort_order").order("name"),
      sb.from("gw_role_businesses").select("*"),
      sb.from("gw_groups").select("id, name").order("sort_order").order("name"),
    ]).then((r) => r.map((x) => x.data || []));
    if (stale(seq)) return;
    const groupName = new Map(groups.map((g) => [g.id, g.name]));
    const NOTICE = ["can_post_notice", "can_delete_notice"];
    const UG = ["can_grant_module", "can_revoke_module", "can_set_module_admin", "can_add_business_user", "can_remove_business_user", "can_view_users"];
    const GLOBAL_MOD = ["can_manage_module_access", "can_edit_module_name"];
    const bizRows = (rid) => rb.filter((x) => x.role_id === rid);
    const hasAny = (row, keys) => keys.some((k) => row[k]);
    const th = (text, extra) => `<th class="px-4 py-3 text-left text-xs font-semibold tracking-wide text-slate-500 uppercase ${extra || ""}">${esc(text)}</th>`;

    view.innerHTML = `<div class="space-y-4">
      <div class="flex items-center justify-end">
        <button id="role-add" class="${btn("primary")} shrink-0">${icon("plus")} ${esc(tr("add"))}</button>
      </div>
      ${
        roles.length
          ? `<div class="${cls.card} overflow-x-auto">
              <table class="w-full min-w-[640px] text-sm">
                <thead class="border-b border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-white/5"><tr>
                  ${th(tr("colRole"))}${th(tr("colBusiness"))}${th(tr("colDescription"))}<th class="w-32"></th>
                </tr></thead>
                <tbody class="divide-y divide-slate-100 dark:divide-slate-800">${roles
                  .map((r) => {
                    const biz = bizRows(r.id).filter((x) => hasAny(x, [...NOTICE, ...UG]));
                    return `<tr class="align-top">
                      <td class="px-4 py-3 font-semibold">${esc(r.name)}</td>
                      <td class="px-4 py-3">${biz.length ? `<div class="flex flex-wrap gap-1">${biz.map((x) => badge(groupName.get(x.group_id) || "—", "blue")).join("")}</div>` : `<span class="text-xs text-slate-400">${esc(tr("noBusiness"))}</span>`}</td>
                      <td class="px-4 py-3 text-slate-600 dark:text-slate-300">${esc(r.description || "")}</td>
                      <td class="px-2 py-2 text-right whitespace-nowrap">
                        <button data-view="${r.id}" aria-label="${esc(tr("view"))}" title="${esc(tr("view"))}" class="${btn("ghost", "sm")}">${icon("eye")}</button>
                        <button data-edit="${r.id}" aria-label="${esc(tg("edit"))}" title="${esc(tg("edit"))}" class="${btn("ghost", "sm")}">${icon("pencil")}</button>
                        <button data-del="${r.id}" aria-label="${esc(tg("delete"))}" title="${esc(tg("delete"))}" class="${btn("ghost", "sm")} text-red-600 dark:text-red-400">${icon("trash-2")}</button>
                      </td>
                    </tr>`;
                  })
                  .join("")}</tbody>
              </table>
            </div>`
          : empty(tr("empty"))
      }
    </div>`;
    refreshIcons();

    // 角色设定的内容（readOnly = 查看）
    function body(r, readOnly) {
      const rows = r ? bizRows(r.id) : [];
      const row = (gid) => rows.find((x) => x.group_id === gid) || {};
      const dis = readOnly ? "disabled" : "";
      const box = (name, gid, checked) => `<input type="checkbox" name="${name}" data-g="${gid || ""}" ${checked ? "checked" : ""} ${dis} class="size-4 shrink-0 accent-emerald-600">`;
      const ugOn = r ? r.can_view_user_group || rows.some((x) => hasAny(x, UG)) : false;
      return `<div class="space-y-4">
        ${
          readOnly
            ? `<div><p class="text-lg font-semibold">${esc(r.name)}</p>${r.description ? `<p class="text-sm text-slate-500">${esc(r.description)}</p>` : ""}</div>`
            : `${field(tr("name"), `<input name="name" required maxlength="60" value="${esc(r ? r.name : "")}" placeholder="${esc(tr("namePlaceholder"))}" class="${cls.input}">`)}
               ${field(tg("descriptionLabel"), `<input name="description" value="${esc(r ? r.description || "" : "")}" class="${cls.input}">`)}`
        }
        <div class="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
          <p class="mb-2 text-xs font-bold tracking-wider text-slate-500 uppercase">${esc(tr("groups.noticeBoard"))}</p>
          ${
            groups.length
              ? `<div class="divide-y divide-slate-100 dark:divide-slate-800">${groups
                  .map(
                    (g) => `<div class="flex flex-wrap items-center gap-x-4 gap-y-1 py-1.5">
                      <span class="w-40 truncate text-sm font-medium">${esc(g.name)}</span>
                      ${NOTICE.map((k) => `<label class="flex items-center gap-1.5 text-sm">${box(k, g.id, row(g.id)[k])}${esc(tr("funcs." + k))}</label>`).join("")}
                    </div>`,
                  )
                  .join("")}</div>`
              : `<p class="text-sm text-slate-400">${esc(tr("noBusinessYet"))}</p>`
          }
        </div>
        <div class="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
          <p class="mb-2 text-xs font-bold tracking-wider text-slate-500 uppercase">${esc(tr("groups.module"))}</p>
          <div class="grid gap-x-4 gap-y-2 sm:grid-cols-2">${GLOBAL_MOD.map((k) => `<label class="flex items-center gap-2 text-sm">${box(k, "", r && r[k])}${esc(tr("funcs." + k))}</label>`).join("")}</div>
        </div>
        <div class="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
          <label class="flex items-center gap-2 text-sm font-semibold">${box("can_view_user_group", "", ugOn)}${esc(tr("funcs.can_view_user_group"))}</label>
          <div data-ug class="mt-3 ${ugOn ? "" : "hidden"}">
            ${
              groups.length
                ? `<div class="divide-y divide-slate-100 dark:divide-slate-800">${groups
                    .map(
                      (g) => `<div class="py-2">
                        <p class="mb-1 text-sm font-medium">${esc(g.name)}</p>
                        <div class="grid gap-x-4 gap-y-1 sm:grid-cols-2">${UG.map((k) => `<label class="flex items-center gap-1.5 text-sm">${box(k, g.id, row(g.id)[k])}${esc(tr("funcs." + k))}</label>`).join("")}</div>
                      </div>`,
                    )
                    .join("")}</div>`
                : `<p class="text-sm text-slate-400">${esc(tr("noBusinessYet"))}</p>`
            }
          </div>
        </div>
        <label class="flex items-center gap-2 text-sm font-semibold">${box("can_view_audit", "", r && r.can_view_audit)}${esc(tr("funcs.can_view_audit"))}</label>
      </div>`;
    }

    function viewDialog(r) {
      const m = modal(
        tr("viewTitle"),
        `${body(r, true)}
         <div class="mt-4 flex justify-end gap-2"><button data-edit-now class="${btn("secondary")}">${icon("pencil")} ${esc(tg("edit"))}</button><button data-done class="${btn("primary")}">${esc(t("admin.users.done"))}</button></div>`,
        { wide: true },
      );
      refreshIcons();
      $("[data-done]", m.el).onclick = m.close;
      $("[data-edit-now]", m.el).onclick = () => (m.close(), dialog(r));
    }

    function dialog(r) {
      const m = modal(
        r ? tr("editTitle") : tr("addTitle"),
        `<form class="space-y-4">
          <div data-err></div>
          ${body(r, false)}
          <div class="flex justify-end gap-2">
            <button type="button" data-cancel class="${btn("secondary")}">${esc(tg("cancel"))}</button>
            <button type="submit" class="${btn("primary")}">${esc(tg("save"))}</button>
          </div>
        </form>`,
        { wide: true },
      );
      refreshIcons();
      const f = $("form", m.el);
      $("[data-cancel]", m.el).onclick = m.close;
      const ugBox = $("[name=can_view_user_group]", f);
      f.addEventListener("change", (e) => {
        const el = e.target;
        if (el === ugBox) return $("[data-ug]", f).classList.toggle("hidden", !el.checked);
        // 勾了任何 Business 动作 → 自动勾 User & Group Manage
        if (UG.includes(el.name) && el.checked) ((ugBox.checked = true), $("[data-ug]", f).classList.remove("hidden"));
      });
      f.addEventListener("submit", async (e) => {
        e.preventDefault();
        const submit = $("button[type=submit]", f);
        submit.disabled = true;
        const fail = (error) => (($("[data-err]", m.el).innerHTML = alertBox(error && error.code === "23505" ? tr("duplicate") : tg("saveFailed"))), (submit.disabled = false));
        const perBiz = {};
        groups.forEach((g) => (perBiz[g.id] = {}));
        $$("input[data-g]", f).forEach((x) => {
          if (x.dataset.g) perBiz[x.dataset.g][x.name] = x.checked;
        });
        const anyUg = Object.values(perBiz).some((p) => hasAny(p, UG));
        const row = {
          name: f.name.value.trim(),
          description: f.description.value.trim() || null,
          can_view_user_group: ugBox.checked || anyUg,
          can_view_audit: f.can_view_audit.checked,
          can_manage_module_access: f.can_manage_module_access.checked,
          can_edit_module_name: f.can_edit_module_name.checked,
        };
        const saved = r ? await sb.from("gw_roles").update(row).eq("id", r.id).select().single() : await sb.from("gw_roles").insert(row).select().single();
        if (saved.error) return fail(saved.error);
        const id = saved.data.id;
        // 每个 Business 一行：有勾任何功能的保留 / 新增，全部没勾的拿掉
        const keep = groups.filter((g) => hasAny(perBiz[g.id], [...NOTICE, ...UG])).map((g) => ({ role_id: id, group_id: g.id, ...perBiz[g.id] }));
        const drop = groups.filter((g) => !hasAny(perBiz[g.id], [...NOTICE, ...UG])).map((g) => g.id);
        const [r1, r2] = await Promise.all([
          keep.length ? sb.from("gw_role_businesses").upsert(keep, { onConflict: "role_id,group_id" }) : Promise.resolve({}),
          drop.length ? sb.from("gw_role_businesses").delete().eq("role_id", id).in("group_id", drop) : Promise.resolve({}),
        ]);
        if (r1.error || r2.error) return fail(r1.error || r2.error);
        m.close();
        rolesTab();
      });
    }

    view.onclick = async (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.id === "role-add") return dialog(null);
      const r = roles.find((x) => x.id === (b.dataset.view || b.dataset.edit || b.dataset.del));
      if (!r) return;
      if (b.dataset.view) return viewDialog(r);
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
    const [groups, companies, companyRows] = await Promise.all([
      sb.from("gw_groups").select("*").order("sort_order").order("name"),
      sb.from("gw_business_companies").select("group_id, company_id, area, area_unit"),
      sb.from("gw_companies").select("id, name, code, short_name"),
    ]).then((r) => r.map((x) => x.data || []));
    if (stale(seq)) return;
    const coShort = new Map(companyRows.map((c) => [c.id, c.short_name || c.code || c.name]));

    function draw() {
      view.innerHTML = `<div class="space-y-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div></div>
          <button id="biz-add" class="${btn("primary")}">${icon("plus")} ${esc(tb("add"))}</button>
        </div>
        ${
          groups.length
            ? `<div id="biz-cards" class="${cls.card} divide-y divide-slate-100 dark:divide-slate-800">${groups
                .map((g) => {
                  const cos = companies.filter((l) => l.group_id === g.id && coShort.get(l.company_id));
                  return `<div data-card="${g.id}" class="flex items-center gap-3 px-3 py-3">
                    ${grip()}
                    <div class="min-w-0 flex-1">
                      <div class="flex flex-wrap items-center gap-2">
                        <span class="font-semibold">${esc(g.name)}</span>
                        ${g.code ? `<span class="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs dark:bg-white/10">${esc(g.code)}</span>` : badge(t("admin.company.noCode"), "amber")}
                        ${cos.length ? `<span class="text-sm text-slate-500">: ${cos.map((l) => `<button data-info="${l.company_id}" data-from="${g.id}" class="hover:underline">${esc(coShort.get(l.company_id))}</button>`).join(", ")}</span>` : ""}
                      </div>
                      ${g.description ? `<p class="text-xs text-slate-500">${esc(g.description)}</p>` : ""}
                    </div>
                    <button data-edit="${g.id}" aria-label="${esc(tg("edit"))}" class="${btn("ghost", "sm")}">${icon("pencil")}</button>
                    <button data-del="${g.id}" aria-label="${esc(tg("delete"))}" class="${btn("ghost", "sm")} text-red-600 dark:text-red-400">${icon("trash-2")}</button>
                  </div>`;
                })
                .join("")}</div>`
            : empty(tb("empty"))
        }
      </div>`;
      refreshIcons();
      sortableCards($("#biz-cards"), "gw_groups", () => toast(t("admin.company.orderSaved")));
    }

    function dialog(g) {
      const m = modal(
        g ? tb("editTitle") : tb("addTitle"),
        `<form class="space-y-4">
          <div data-err></div>
          <div class="grid gap-4 sm:grid-cols-[10rem_1fr]">
            ${field(tb("code"), `<input name="code" required maxlength="20" value="${esc(g ? g.code || "" : "")}" ${g && g.code ? "readonly" : ""} class="${cls.input} font-mono uppercase">`)}
            ${field(tb("name"), `<input name="name" required value="${esc(g ? g.name : "")}" class="${cls.input}">`)}
          </div>
          ${field(tg("descriptionLabel"), `<input name="description" value="${esc(g ? g.description || "" : "")}" class="${cls.input}">`)}
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
        const row = { code: f.code.value.trim().toUpperCase(), name: f.name.value.trim(), description: f.description.value.trim() || null };
        const { error } = g ? await sb.from("gw_groups").update(row).eq("id", g.id) : await sb.from("gw_groups").insert(row);
        if (error) return ($("[data-err]", m.el).innerHTML = alertBox(error.code === "23505" ? tb("duplicate") : error.code === "23514" ? tb("badCode") : tg("saveFailed")));
        m.close();
        businessTab();
      });
    }

    view.onclick = async (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      const d = b.dataset;
      if (b.id === "biz-add") return dialog(null);
      if (d.info) return companyInfo(d.info, d.from || null);
      if (d.edit) return dialog(groups.find((x) => x.id === d.edit));
      if (d.del) {
        const g = groups.find((x) => x.id === d.del);
        if (!(await confirmDialog(tb("deleteTitle"), tb("deleteBody", { name: g.name }), tg("delete"), tg("cancel")))) return;
        const { error } = await sb.from("gw_groups").delete().eq("id", g.id);
        if (error) setMsg(tg("saveFailed"));
        return businessTab();
      }
    };
    draw();
  }

  // ---------------------------------------------------------------- Company 资料窗（Company 页、Business 页、群组列表共用）
  /* 永远显示同一组基本资料：名称、代码、说明、注册号码，以及它属于的每个 Business 和面积。
     fromGroupId：从某个 Business 点进来时，那个 Business 当标题、先显示，其他 Business 放后面。 */
  async function companyInfo(companyId, fromGroupId) {
    const tc = (k, v) => t("admin.company." + k, v);
    const m = modal("", GW.spinner());
    const [{ data: c }, { data: links }, { data: groups }, { data: mems }] = await Promise.all([
      sb.from("gw_companies").select("*").eq("id", companyId).maybeSingle(),
      sb.from("gw_business_companies").select("group_id, area, area_unit").eq("company_id", companyId),
      sb.from("gw_groups").select("id, name, code").order("sort_order").order("name"),
      sb.from("gw_member_companies").select("group_id").eq("company_id", companyId),
    ]);
    if (!c) return m.close();
    const gName = new Map((groups || []).map((g) => [g.id, g]));
    const rows = (links || [])
      .map((l) => ({ ...l, g: gName.get(l.group_id) }))
      .filter((l) => l.g)
      .sort((a, b) => (a.group_id === fromGroupId ? -1 : b.group_id === fromGroupId ? 1 : 0));
    const area = (l) => (l.area != null ? `${Number(l.area).toLocaleString(GW.LOCALE)} ${esc(l.area_unit || "")}` : "—");
    const people = (gid) => (mems || []).filter((x) => x.group_id === gid).length;
    const from = fromGroupId ? gName.get(fromGroupId) : null;
    const h = m.el.parentElement.querySelector("h2");
    if (h) h.textContent = from ? from.name : c.name;
    m.el.innerHTML = `<div class="space-y-4">
      <div class="flex items-start gap-3">
        <span class="flex size-11 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-600 dark:bg-white/10 dark:text-slate-300">${icon("building-2", "size-6")}</span>
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2"><span class="text-lg font-semibold">${esc(c.name)}</span>${c.code ? `<span class="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs dark:bg-white/10">${esc(c.code)}</span>` : ""}${c.is_active ? "" : badge(tc("inactive"))}</div>
          <p class="text-sm text-slate-500">${esc([c.short_name, c.registration_no].filter(Boolean).join(" · "))}</p>
          ${c.description ? `<p class="mt-1 text-sm">${esc(c.description)}</p>` : ""}
        </div>
      </div>
      <div class="divide-y divide-slate-100 rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
        ${
          rows.length
            ? rows
                .map(
                  (l, i) => `<div class="flex items-center gap-3 px-3 py-2.5 ${i === 0 && from ? "bg-brand-50/60 dark:bg-brand-900/20" : ""}">
                    ${icon("briefcase-business", "size-4 shrink-0 text-brand-600")}
                    <span class="min-w-0 flex-1"><span class="block truncate text-sm font-medium">${esc(l.g.name)}</span><span class="block text-xs text-slate-500">${esc(tc("members", { count: people(l.group_id) }))}</span></span>
                    <span class="text-sm"><span class="text-xs text-slate-500">${esc(tc("area"))} </span><span class="font-medium">${area(l)}</span></span>
                  </div>`,
                )
                .join("")
            : `<p class="px-3 py-4 text-center text-sm text-slate-400">${esc(tc("noBusinessYet"))}</p>`
        }
      </div>
      <div class="flex justify-end"><button data-done class="${btn("primary")}">${esc(t("admin.users.done"))}</button></div>
    </div>`;
    refreshIcons();
    $("[data-done]", m.el).onclick = m.close;
  }

  // 拖拉排顺序（Business、Company 卡片）：拖完把新的顺序存进 sort_order
  function sortableCards(container, table, onSaved) {
    if (!isSuper || !container || !window.Sortable) return null;
    return window.Sortable.create(container, {
      handle: "[data-grip]",
      animation: 150,
      delay: 150,
      delayOnTouchOnly: true,
      onEnd: async () => {
        const ids = $$("[data-card]", container).map((el) => el.dataset.card);
        await Promise.all(ids.map((id, i) => sb.from(table).update({ sort_order: i }).eq("id", id)));
        if (onSaved) onSaved();
      },
    });
  }
  const grip = () => `<span data-grip title="${esc(t("admin.company.dragOrder"))}" class="cursor-grab touch-none rounded p-1 text-slate-300 hover:text-slate-500 active:cursor-grabbing">${icon("grip-vertical", "size-4")}</span>`;

  // ---------------------------------------------------------------- 筛选：小漏斗图示，点开勾选（可多选），Clear all
  // sections = [{ key, title, items: [{ id, name }] }]；state[key] = Set；变动时 onChange()
  function filterMenu(sections, state, onChange) {
    const wrap = document.createElement("div");
    wrap.className = "relative";
    let open = false;
    const total = () => sections.reduce((n, s) => n + state[s.key].size, 0);
    function paint() {
      wrap.innerHTML = `<button type="button" data-fbtn aria-label="${esc(t("admin.filter.title"))}" title="${esc(t("admin.filter.title"))}" class="${btn(total() ? "primary" : "secondary", "sm")} relative">${icon("list-filter", "size-4")}${total() ? `<span class="ml-0.5 text-xs">${total()}</span>` : ""}</button>
        <div data-fpanel class="${open ? "" : "hidden"} absolute right-0 z-30 mt-1 w-72 max-w-[85vw] rounded-xl border border-slate-200 bg-white p-3 shadow-lg dark:border-slate-700 dark:bg-slate-900">
          <div class="max-h-72 space-y-3 overflow-y-auto">${sections
            .map(
              (s) => `<div><p class="mb-1 text-[11px] font-bold tracking-wider text-slate-500 uppercase">${esc(s.title)}</p>
                ${s.items.length ? s.items.map((x) => `<label class="flex items-center gap-2 py-0.5 text-sm"><input type="checkbox" data-fkey="${s.key}" value="${x.id}" ${state[s.key].has(x.id) ? "checked" : ""} class="size-4 accent-emerald-600"><span class="truncate">${esc(x.name)}</span></label>`).join("") : `<p class="text-xs text-slate-400">—</p>`}
              </div>`,
            )
            .join("")}</div>
          <button type="button" data-fclear class="${btn("ghost", "sm")} mt-2 w-full">${esc(t("admin.filter.clear"))}</button>
        </div>`;
      refreshIcons();
    }
    wrap.addEventListener("click", (e) => {
      if (e.target.closest("[data-fbtn]")) return ((open = !open), paint());
      if (e.target.closest("[data-fclear]")) {
        sections.forEach((s) => state[s.key].clear());
        paint();
        onChange();
      }
    });
    wrap.addEventListener("change", (e) => {
      const el = e.target.closest("[data-fkey]");
      if (!el) return;
      const set = state[el.dataset.fkey];
      el.checked ? set.add(el.value) : set.delete(el.value);
      paint();
      onChange();
    });
    const outside = (e) => {
      if (!wrap.isConnected) return document.removeEventListener("click", outside);
      if (open && !e.composedPath().includes(wrap)) ((open = false), paint());
    };
    document.addEventListener("click", outside);
    paint();
    return wrap;
  }

  // ================================================================ Company（Master Manage；独立主资料，可以属于多个 Business，对应到现有系统）
  async function companyTab() {
    const seq = routeSeq;
    const tc = (k, v) => t("admin.company." + k, v);
    const tg = (k, v) => t("admin.groups." + k, v);
    const [companies, groups, links, mappings, modules] = await Promise.all([
      sb.from("gw_companies").select("*").order("sort_order").order("name"),
      sb.from("gw_groups").select("id, name").order("sort_order").order("name"),
      sb.from("gw_business_companies").select("group_id, company_id, area, area_unit"),
      sb.from("gw_company_mappings").select("*").order("created_at"),
      sb.from("gw_modules").select("id, code, name, kind").order("sort_order").order("name"),
    ]).then((r) => r.map((x) => x.data || []));
    if (stale(seq)) return;
    const modById = new Map(modules.map((m) => [m.id, m]));
    const linksOf = (cid) => links.filter((l) => l.company_id === cid);
    const gName = new Map(groups.map((g) => [g.id, g.name]));
    const state = { biz: new Set() };
    let query = "";
    let sorter = null;

    view.innerHTML = `<div class="space-y-4">
      <div class="flex items-center gap-2">
        <div class="flex-1"></div>
        <input id="co-q" type="search" placeholder="${esc(tc("search"))}" class="${cls.input} h-9 min-w-0 sm:w-56">
        <span id="co-filter"></span>
        <button id="co-add" class="${btn("primary")} shrink-0">${icon("plus")} ${esc(tc("add"))}</button>
      </div>
      <div id="co-list"></div>
    </div>`;
    refreshIcons();
    $("#co-filter").replaceWith(filterMenu([{ key: "biz", title: t("admin.tabs.business"), items: groups }], state, drawList));
    $("#co-q").addEventListener("input", (e) => ((query = e.target.value), drawList()));

    // 一行：拖拉图示、代码、公司名称 : Business
    function drawList() {
      if (sorter) sorter.destroy();
      sorter = null;
      const q = query.trim().toLowerCase();
      const list = companies.filter(
        (c) =>
          (!q || [c.code, c.name, c.short_name, c.registration_no].filter(Boolean).join(" ").toLowerCase().includes(q)) &&
          (!state.biz.size || linksOf(c.id).some((l) => state.biz.has(l.group_id))),
      );
      $("#co-list").innerHTML = list.length
        ? `<div id="co-cards" class="${cls.card} divide-y divide-slate-100 dark:divide-slate-800">${list
            .map((c) => {
              const bs = linksOf(c.id).filter((l) => gName.has(l.group_id));
              return `<div data-card="${c.id}" class="flex items-center gap-3 px-3 py-3">
                ${q || state.biz.size ? "" : grip()}
                ${c.code ? `<span class="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs dark:bg-white/10">${esc(c.code)}</span>` : badge(tc("noCode"), "amber")}
                <div class="min-w-0 flex-1 truncate">
                  <button data-info="${c.id}" class="font-semibold hover:underline">${esc(c.name)}</button>${bs.length ? `<span class="text-sm text-slate-500"> : ${bs.map((l) => `<button data-info="${c.id}" data-from="${l.group_id}" class="hover:underline">${esc(gName.get(l.group_id))}</button>`).join(", ")}</span>` : ""}
                </div>
                <button data-edit="${c.id}" aria-label="${esc(tg("edit"))}" class="${btn("ghost", "sm")}">${icon("pencil")}</button>
              </div>`;
            })
            .join("")}</div>`
        : empty(tc(companies.length ? "noMatch" : "empty"));
      refreshIcons();
      if (!q && !state.biz.size) sorter = sortableCards($("#co-cards"), "gw_companies", () => toast(tc("orderSaved")));
    }

    function dialog(c) {
      const v = c || { code: "", name: "", short_name: "", registration_no: "", description: "" };
      const mine = c ? linksOf(c.id) : [];
      const link = (gid) => mine.find((l) => l.group_id === gid);
      const m = modal(
        c ? tc("editTitle") : tc("addTitle"),
        `<form class="space-y-4"><div data-err></div>
          <div class="grid gap-4 sm:grid-cols-2">
            ${field(tc("code"), `<input name="code" required maxlength="20" value="${esc(v.code || "")}" ${c && c.code ? "readonly" : ""} class="${cls.input} font-mono uppercase">`)}
            ${field(tc("name"), `<input name="name" required maxlength="100" value="${esc(v.name)}" class="${cls.input}">`)}
            ${field(tc("shortName"), `<input name="short_name" maxlength="40" value="${esc(v.short_name || "")}" class="${cls.input}">`)}
            ${field(tc("registrationNo"), `<input name="registration_no" maxlength="40" value="${esc(v.registration_no || "")}" class="${cls.input}">`)}
          </div>
          ${field(tc("descriptionLabel"), `<input name="description" maxlength="300" value="${esc(v.description || "")}" class="${cls.input}">`)}
          <div>
            <p class="mb-1.5 ${cls.label}">${esc(tc("businesses"))}</p>
            ${
              groups.length
                ? `<div class="divide-y divide-slate-100 rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-800">${groups
                    .map((g) => {
                      const l = link(g.id);
                      return `<div class="flex flex-wrap items-center gap-3 px-3 py-2">
                        <label class="flex min-w-0 flex-1 items-center gap-2 text-sm"><input type="checkbox" data-biz="${g.id}" ${l ? "checked" : ""} class="size-4 accent-emerald-600"><span class="truncate font-medium">${esc(g.name)}</span></label>
                        <span data-area-box="${g.id}" class="${l ? "flex" : "hidden"} items-center gap-1.5">
                          <input data-area="${g.id}" type="number" min="0" step="0.01" placeholder="${esc(tc("area"))}" aria-label="${esc(tc("area"))}" value="${l && l.area != null ? esc(String(l.area)) : ""}" class="${cls.input} h-8 w-32">
                          <input data-unit="${g.id}" type="hidden" value="${esc(l ? l.area_unit || "ha" : "ha")}">
                        </span>
                      </div>`;
                    })
                    .join("")}</div>`
                : `<p class="text-sm text-slate-400">${esc(tc("noBusiness"))}</p>`
            }
          </div>
          ${c ? `<div data-maps></div>` : ""}
          <div class="flex justify-between gap-2">
            ${c ? `<button type="button" data-del class="${btn("ghost")} text-red-600 dark:text-red-400">${icon("trash-2")} ${esc(tg("delete"))}</button>` : "<span></span>"}
            <div class="flex gap-2"><button type="button" data-cancel class="${btn("secondary")}">${esc(tg("cancel"))}</button><button type="submit" class="${btn("primary")}">${esc(tg("save"))}</button></div>
          </div>
        </form>`,
        { wide: true },
      );
      refreshIcons();
      $("[data-cancel]", m.el).onclick = m.close;
      // 勾了 Business 才出现面积栏
      m.el.addEventListener("change", (e) => {
        const b = e.target.closest("input[data-biz]");
        if (!b) return;
        const box = $(`[data-area-box="${b.dataset.biz}"]`, m.el);
        box.classList.toggle("hidden", !b.checked);
        box.classList.toggle("flex", b.checked);
        if (b.checked) $("input[data-area]", box).focus();
      });

      // 对应到现有系统（只有已存在的 Company 才能加）：直接在编辑窗里加 / 删
      if (c) {
        const box = $("[data-maps]", m.el);
        const drawMaps = () => {
          const maps = mappings.filter((x) => x.company_id === c.id);
          box.innerHTML = `<p class="mb-1.5 ${cls.label}">${esc(tc("mappings"))}</p>
            ${
              maps.length
                ? `<div class="mb-2 divide-y divide-slate-100 rounded-xl border border-slate-200 text-sm dark:divide-slate-800 dark:border-slate-800">${maps
                    .map((x) => {
                      const mod = modById.get(x.module_id);
                      return `<div class="flex items-center gap-2 px-3 py-1.5">
                        <span class="min-w-0 flex-1 truncate"><span class="font-medium">${esc(mod ? mod.name : "—")}</span> → <span class="font-mono">${esc(x.external_id)}</span>${x.external_name ? ` <span class="text-slate-500">(${esc(x.external_name)})</span>` : ""}</span>
                        <button type="button" data-map-del="${x.id}" aria-label="${esc(tg("delete"))}" class="${btn("ghost", "sm")} text-red-600 dark:text-red-400">${icon("x")}</button>
                      </div>`;
                    })
                    .join("")}</div>`
                : ""
            }
            <div data-map-err></div>
            ${
              modules.length
                ? `<div class="grid gap-2 sm:grid-cols-[1fr_8rem_1fr_auto]">
                    ${select("map_module", modules.map((x) => [x.id, x.name + " (" + x.code + ")"]), "")}
                    <input data-map-id maxlength="100" placeholder="${esc(tc("externalId"))}" class="${cls.input} font-mono">
                    <input data-map-name maxlength="120" placeholder="${esc(tc("externalName"))}" class="${cls.input}">
                    <button type="button" data-map-add class="${btn("secondary")}">${icon("link-2")} ${esc(tc("addMapping"))}</button>
                  </div>`
                : ""
            }`;
          refreshIcons();
        };
        drawMaps();
        box.addEventListener("click", async (e) => {
          const b = e.target.closest("button");
          if (!b) return;
          if (b.dataset.mapDel) {
            const { error } = await sb.from("gw_company_mappings").delete().eq("id", b.dataset.mapDel);
            if (error) return ($("[data-map-err]", box).innerHTML = alertBox(tg("saveFailed")));
            mappings.splice(mappings.findIndex((x) => x.id === b.dataset.mapDel), 1);
            return drawMaps();
          }
          if ("mapAdd" in b.dataset) {
            const ext = $("[data-map-id]", box).value.trim();
            if (!ext) return $("[data-map-id]", box).focus();
            const { data, error } = await sb
              .from("gw_company_mappings")
              .insert({ company_id: c.id, module_id: $("[name=map_module]", box).value, external_id: ext, external_name: $("[data-map-name]", box).value.trim() || null })
              .select()
              .single();
            if (error) return ($("[data-map-err]", box).innerHTML = alertBox(tc(error.code === "23505" ? "mappingDuplicate" : "saveFailed")));
            mappings.push(data);
            drawMaps();
          }
        });
        $("[data-del]", m.el).onclick = async () => {
          if (!(await confirmDialog(tc("deleteTitle"), tc("deleteBody", { name: c.name }), tg("delete"), tg("cancel")))) return;
          const { error } = await sb.from("gw_companies").delete().eq("id", c.id);
          if (error) return ($("[data-err]", m.el).innerHTML = alertBox(tc("inUse")));
          m.close();
          companyTab();
        };
      }

      $("form", m.el).addEventListener("submit", async (e) => {
        e.preventDefault();
        const f = e.target;
        const submit = $("button[type=submit]", f);
        submit.disabled = true;
        submit.innerHTML = `<span class="size-4 animate-spin rounded-full border-2 border-white/40 border-t-white"></span>`;
        const row = {
          code: f.code.value.trim().toUpperCase(),
          name: f.name.value.trim(),
          short_name: f.short_name.value.trim() || null,
          registration_no: f.registration_no.value.trim() || null,
          description: f.description.value.trim() || null,
        };
        const fail = (error) => (($("[data-err]", m.el).innerHTML = alertBox(tc(error.code === "23505" ? "duplicate" : error.code === "23514" ? "badCode" : "saveFailed"))), (submit.disabled = false), (submit.textContent = tg("save")));
        const saved = c ? await sb.from("gw_companies").update(row).eq("id", c.id).select().single() : await sb.from("gw_companies").insert({ ...row, sort_order: companies.length }).select().single();
        if (saved.error) return fail(saved.error);
        const id = saved.data.id;
        // Business 连结 + 面积：勾的新增 / 更新，没勾的拿掉（拿掉前先确认有没有人放在里面）
        const want = $$("[data-biz]", m.el).filter((x) => x.checked).map((x) => x.dataset.biz);
        const drop = mine.filter((l) => !want.includes(l.group_id)).map((l) => l.group_id);
        // 只写有变动的：新勾的、面积改了的、取消勾的
        const rows = want
          .map((gid) => {
            const a = $(`[data-area="${gid}"]`, m.el).value;
            return { group_id: gid, company_id: id, area: a === "" ? null : Number(a), area_unit: $(`[data-unit="${gid}"]`, m.el).value.trim() || "ha" };
          })
          .filter((r) => {
            const l = link(r.group_id);
            return !l || Number(l.area) !== Number(r.area) || (l.area == null) !== (r.area == null) || (l.area_unit || "ha") !== r.area_unit;
          });
        if (drop.length) {
          const { count: n } = await sb.from("gw_member_companies").select("user_id", { count: "exact", head: true }).eq("company_id", id).in("group_id", drop);
          if (n && !(await confirmDialog(tc("unlinkTitle"), tc("unlinkBody", { count: n }), tc("unlink"), tg("cancel")))) return fail({});
        }
        const [r1, r2] = await Promise.all([
          drop.length ? sb.from("gw_business_companies").delete().eq("company_id", id).in("group_id", drop) : Promise.resolve({}),
          rows.length ? sb.from("gw_business_companies").upsert(rows, { onConflict: "group_id,company_id" }) : Promise.resolve({}),
        ]);
        if (r1.error || r2.error) return fail(r1.error || r2.error);
        m.close();
        companyTab();
      });
    }

    view.onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      const d = b.dataset;
      if (b.id === "co-add") return dialog(null);
      if (d.info) return companyInfo(d.info, d.from || null);
      if (d.edit) return dialog(companies.find((x) => x.id === d.edit));
    };
    drawList();
  }

  // ================================================================ Module（Master Manage；只列 MJM Intranet 旗下的系统模块）
  /* 系统模块由开发时登录（例如 Diesel），这里不输入网址。
     可以改：名称、说明、照片、Business 标签（勾了 Business 才出现它的 Company 标签）。
     外部网站的连结图示改由用户自己在主画面「Add Icon」加。 */
  async function modulesTab() {
    const seq = routeSeq;
    const tmod = (k, v) => t("admin.modules." + k, v);
    // Sector / 负责人两栏要数据库更新过才有；还没更新时照常显示，只是没有这两项
    const [sectorRes, tagRes] = await Promise.all([sb.from("gw_sectors").select("id, name").order("sort_order").order("name"), sb.from("gw_group_modules").select("group_id, module_id, sector_id, lead_user_id")]);
    const sectorsReady = !sectorRes.error && !tagRes.error;
    const sectors = sectorsReady ? sectorRes.data || [] : [];
    const [modules, groups, companies, bizTags, coTags, bizCo, people] = await Promise.all([
      sb.from("gw_modules").select("*").eq("kind", "system").order("sort_order").order("name").then((r) => r.data || []),
      sb.from("gw_groups").select("id, name").order("sort_order").order("name").then((r) => r.data || []),
      sb.from("gw_companies").select("id, code, name").order("sort_order").order("name").then((r) => r.data || []),
      sectorsReady ? Promise.resolve(tagRes.data || []) : sb.from("gw_group_modules").select("group_id, module_id").then((r) => r.data || []),
      sb.from("gw_module_companies").select("module_id, company_id").then((r) => r.data || []),
      sb.from("gw_business_companies").select("group_id, company_id").then((r) => r.data || []),
      sb.from("gw_profiles").select("id, full_name").eq("status", "active").order("full_name").then((r) => r.data || []),
    ]);
    if (stale(seq)) return;
    const sectorName = new Map(sectors.map((x) => [x.id, x.name]));
    const personName = new Map(people.map((x) => [x.id, x.full_name]));
    const groupName = new Map(groups.map((g) => [g.id, g.name]));
    const companyName = new Map(companies.map((c) => [c.id, c.code || c.name]));
    const companiesIn = (gid) => companies.filter((c) => bizCo.some((l) => l.group_id === gid && l.company_id === c.id));
    const canRename = (mid) => isSuper || (C.can_edit_module_name && (me.roleModules || []).includes(mid));
    const tagsOf = (mid) => [
      ...bizTags.filter((x) => x.module_id === mid).map((x) => badge(groupName.get(x.group_id) || "—", "blue")),
      ...coTags.filter((x) => x.module_id === mid).map((x) => badge(companyName.get(x.company_id) || "—")),
    ];
    const logo = (m, size) =>
      m.image_url
        ? `<img src="${esc(m.image_url)}" alt="" class="${size} shrink-0 rounded-xl object-cover">`
        : `<span class="flex ${size} shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-700/20 dark:text-brand-100">${moduleIcon(m.icon, "size-5")}</span>`;

    const state = { biz: new Set(), co: new Set(), sector: new Set() };
    view.innerHTML = `<div class="space-y-4">
      <div class="flex items-center justify-end"><span id="mod-filter"></span></div>
      <div id="mod-list"></div>
    </div>`;
    $("#mod-filter").replaceWith(
      filterMenu(
        [
          { key: "biz", title: t("admin.tabs.business"), items: groups },
          { key: "co", title: t("admin.tabs.company"), items: companies.map((c) => ({ id: c.id, name: (c.code ? c.code + " · " : "") + c.name })) },
          ...(sectorsReady ? [{ key: "sector", title: t("admin.tabs.sectors"), items: sectors }] : []),
        ],
        state,
        drawList,
      ),
    );
    // 一行 = 一个 Business × 一个模块：最左边 Business 标签，然后模块名称，右边是 Sector，再来是主要负责人
    function drawList() {
      const rows = [];
      groups.forEach((g) =>
        modules.forEach((m) => {
          const bt = bizTags.find((x) => x.group_id === g.id && x.module_id === m.id);
          if (bt) rows.push({ g, m, bt });
        }),
      );
      modules.filter((m) => !bizTags.some((x) => x.module_id === m.id)).forEach((m) => rows.push({ g: null, m, bt: null }));
      const list = rows.filter(
        ({ g, m, bt }) =>
          (!state.biz.size || (g && state.biz.has(g.id))) &&
          (!state.co.size || coTags.some((x) => x.module_id === m.id && state.co.has(x.company_id))) &&
          (!state.sector.size || (bt && bt.sector_id && state.sector.has(bt.sector_id))),
      );
      $("#mod-list").innerHTML = list.length
        ? `<div class="${cls.card} divide-y divide-slate-200 dark:divide-slate-800">${list
            .map(({ g, m, bt }) => {
              const sec = bt && bt.sector_id ? sectorName.get(bt.sector_id) : "";
              const lead = bt && bt.lead_user_id ? personName.get(bt.lead_user_id) : "";
              return `<div data-row class="flex flex-wrap items-center gap-x-3 gap-y-1.5 p-3 ${m.is_active ? "" : "opacity-60"}">
                <span class="w-32 shrink-0">${g ? badge(g.name, "blue") : badge(tmod("noBusiness"), "amber")}</span>
                ${logo(m, "size-10")}
                <div class="min-w-0 flex-1 basis-40">
                  <p class="truncate"><span class="font-medium">${esc(m.name)}</span>${m.description ? `<span class="text-sm text-slate-500"> : ${esc(m.description)}</span>` : ""}</p>
                </div>
                <span class="w-28 shrink-0">${sec ? badge(sec, "amber") : `<span class="text-xs text-slate-400">—</span>`}</span>
                <span class="flex w-36 shrink-0 items-center gap-1 truncate text-sm ${lead ? "" : "text-slate-400"}" title="${esc(tmod("lead"))}">${icon("user-round", "size-3.5 shrink-0")}<span class="truncate">${esc(lead || "—")}</span></span>
                ${canRename(m.id) ? `<button data-edit="${m.id}" aria-label="${esc(tmod("edit"))}" title="${esc(tmod("edit"))}" class="${btn("ghost", "sm")}">${icon("pencil")}</button>` : ""}
              </div>`;
            })
            .join("")}</div>`
        : empty(tmod(modules.length ? "noMatch" : "empty"));
      refreshIcons();
    }
    drawList();

    function dialog(mod) {
      const bizOn = new Set(bizTags.filter((x) => x.module_id === mod.id).map((x) => x.group_id));
      const tagOf = (gid) => bizTags.find((x) => x.module_id === mod.id && x.group_id === gid) || {};
      const opt = (list, cur) => list.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(cur || "") ? "selected" : ""}>${esc(l)}</option>`).join("");
      const coOn = new Set(coTags.filter((x) => x.module_id === mod.id).map((x) => x.company_id));
      let photo = null; // 新选的照片
      const m = modal(
        tmod("editTitle"),
        `<form class="space-y-4">
          <div data-err></div>
          <div class="flex items-start gap-4">
            <div class="flex flex-col items-center gap-2">
              <div data-preview>${logo(mod, "size-20")}</div>
              ${isSuper ? `<label class="${btn("secondary", "sm")} cursor-pointer">${icon("upload", "size-4")} ${esc(tmod("uploadPhoto"))}<input type="file" name="photo" accept="image/*" class="hidden"></label>` : ""}
            </div>
            <div class="min-w-0 flex-1 space-y-3">
              <div class="grid gap-3 sm:grid-cols-[8rem_1fr]">
                ${field(tmod("kind"), `<input value="${esc(tmod("kinds." + mod.kind))}" readonly class="${cls.input} bg-slate-50 dark:bg-slate-800">`)}
                ${field(tmod("code"), `<input value="${esc(mod.code)}" readonly class="${cls.input} bg-slate-50 font-mono dark:bg-slate-800">`)}
              </div>
              ${field(tmod("name"), `<input name="name" required maxlength="60" value="${esc(mod.name)}" class="${cls.input}">`)}
              ${field(tmod("descriptionLabel"), `<input name="description" maxlength="120" value="${esc(mod.description || "")}" class="${cls.input}">`)}
              ${isSuper ? `<label class="flex items-center gap-2 text-sm"><input type="checkbox" name="is_active" ${mod.is_active ? "checked" : ""} class="size-4 accent-emerald-600">${esc(tmod("activeLabel"))}</label>` : ""}
            </div>
          </div>
          ${
            isSuper
              ? `<div>
                  <p class="mb-1.5 ${cls.label}">${esc(tmod("businessTags"))}</p>
                  ${
                    groups.length
                      ? `<div class="space-y-2">${groups
                          .map((g) => {
                            const cos = companiesIn(g.id);
                            return `<div class="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                              <label class="flex items-center gap-2 text-sm font-medium"><input type="checkbox" name="biz" value="${g.id}" ${bizOn.has(g.id) ? "checked" : ""} class="size-4 accent-emerald-600">${icon("briefcase-business", "size-4 text-brand-600")}${esc(g.name)}</label>
                              ${
                                sectorsReady
                                  ? `<div data-meta="${g.id}" class="mt-2 ml-6 grid gap-2 sm:grid-cols-2 ${bizOn.has(g.id) ? "" : "hidden"}">
                                      <label class="block space-y-1"><span class="text-xs text-slate-500">${esc(tmod("sector"))}</span><select data-sector="${g.id}" class="${cls.input}">${opt([["", "—"], ...sectors.map((x) => [x.id, x.name])], tagOf(g.id).sector_id)}</select></label>
                                      <label class="block space-y-1"><span class="text-xs text-slate-500">${esc(tmod("lead"))}</span><select data-lead="${g.id}" class="${cls.input}">${opt([["", "—"], ...people.map((x) => [x.id, x.full_name])], tagOf(g.id).lead_user_id)}</select></label>
                                    </div>`
                                  : ""
                              }
                              <div data-cos="${g.id}" class="mt-2 ml-6 ${bizOn.has(g.id) ? "" : "hidden"}">
                                ${
                                  cos.length
                                    ? `<label class="mb-1 flex items-center gap-2 text-xs text-slate-500"><input type="checkbox" data-all="${g.id}" class="size-3.5 accent-emerald-600">${esc(tmod("tickAll"))}</label>
                                       <div class="flex flex-wrap gap-x-4 gap-y-1.5">${cos.map((c) => `<label class="flex items-center gap-1.5 text-sm"><input type="checkbox" name="co" data-g="${g.id}" value="${c.id}" ${coOn.has(c.id) ? "checked" : ""} class="size-4 accent-emerald-600">${esc((c.code ? c.code + " · " : "") + c.name)}</label>`).join("")}</div>`
                                    : `<span class="text-xs text-slate-400">${esc(tmod("noCompanies"))}</span>`
                                }
                              </div>
                            </div>`;
                          })
                          .join("")}</div>`
                      : `<p class="text-xs text-slate-400">${esc(tmod("noOptions"))}</p>`
                  }
                </div>`
              : ""
          }
          <div class="flex justify-end gap-2">
            <button type="button" data-cancel class="${btn("secondary")}">${esc(tmod("cancel"))}</button>
            <button type="submit" class="${btn("primary")}">${esc(tmod("save"))}</button>
          </div>
        </form>`,
        { wide: true },
      );
      refreshIcons();
      const f = $("form", m.el);
      $("[data-cancel]", m.el).onclick = m.close;
      m.el.addEventListener("change", (e) => {
        const el = e.target;
        if (el.name === "biz") {
          const box = $(`[data-cos="${el.value}"]`, m.el);
          box.classList.toggle("hidden", !el.checked);
          if (!el.checked) $$("input", box).forEach((x) => (x.checked = false));
          const meta = $(`[data-meta="${el.value}"]`, m.el);
          if (meta) {
            meta.classList.toggle("hidden", !el.checked);
            if (!el.checked) $$("select", meta).forEach((x) => (x.value = ""));
          }
        } else if (el.dataset.all) {
          $$(`input[name=co][data-g="${el.dataset.all}"]`, m.el).forEach((x) => (x.checked = el.checked));
        } else if (el.name === "photo" && el.files[0]) {
          photo = el.files[0];
          $("[data-preview]", m.el).innerHTML = `<img src="${URL.createObjectURL(photo)}" alt="" class="size-20 rounded-xl object-cover">`;
        }
      });
      f.addEventListener("submit", async (e) => {
        e.preventDefault();
        const submit = $("button[type=submit]", f);
        submit.disabled = true;
        const err = (k) => (($("[data-err]", m.el).innerHTML = alertBox(tmod(k))), (submit.disabled = false));
        // 名称 / 说明：经过 gw_rename_module（角色权限在数据库检查）
        const { error } = await sb.rpc("gw_rename_module", { p_module: mod.id, p_name: f.name.value.trim(), p_description: f.description.value.trim() });
        if (error) return err("saveFailed");
        if (isSuper) {
          if (photo) {
            const ext = photo.type === "image/png" ? "png" : photo.type === "image/webp" ? "webp" : photo.type === "image/svg+xml" ? "svg" : "jpg";
            const path = `${mod.code.toLowerCase()}-${Date.now()}.${ext}`;
            const up = await sb.storage.from("module-icons").upload(path, photo, { contentType: photo.type });
            if (up.error) return err("uploadFailed");
            const { data: pub } = sb.storage.from("module-icons").getPublicUrl(path);
            const { error: e2 } = await sb.from("gw_modules").update({ image_url: pub.publicUrl }).eq("id", mod.id);
            if (e2) return err("saveFailed");
          }
          if (f.is_active.checked !== !!mod.is_active) {
            const { error: e3 } = await sb.from("gw_modules").update({ is_active: f.is_active.checked }).eq("id", mod.id);
            if (e3) return err("saveFailed");
          }
          const picked = (name) => new Set($$(`input[name=${name}]:checked`, f).map((x) => x.value));
          const sync = async (table, col, before, after) => {
            const add = [...after].filter((x) => !before.has(x));
            const drop = [...before].filter((x) => !after.has(x));
            if (add.length) {
              const { error } = await sb.from(table).insert(add.map((x) => ({ module_id: mod.id, [col]: x })));
              if (error) return error;
            }
            if (drop.length) {
              const { error } = await sb.from(table).delete().eq("module_id", mod.id).in(col, drop);
              if (error) return error;
            }
          };
          // Business：新增 / 拿掉；留着的看 Sector 和负责人有没有改
          const want = picked("biz");
          const metaOf = (gid) => (sectorsReady ? { sector_id: $(`[data-sector="${gid}"]`, f).value || null, lead_user_id: $(`[data-lead="${gid}"]`, f).value || null } : {});
          const addBiz = [...want].filter((x) => !bizOn.has(x));
          const dropBiz = [...bizOn].filter((x) => !want.has(x));
          if (addBiz.length) {
            const { error } = await sb.from("gw_group_modules").insert(addBiz.map((gid) => ({ module_id: mod.id, group_id: gid, ...metaOf(gid) })));
            if (error) return err("saveFailed");
          }
          if (dropBiz.length) {
            const { error } = await sb.from("gw_group_modules").delete().eq("module_id", mod.id).in("group_id", dropBiz);
            if (error) return err("saveFailed");
          }
          if (sectorsReady)
            for (const gid of [...want].filter((x) => bizOn.has(x))) {
              const now = metaOf(gid);
              const was = tagOf(gid);
              if ((was.sector_id || null) === now.sector_id && (was.lead_user_id || null) === now.lead_user_id) continue;
              const { error } = await sb.from("gw_group_modules").update(now).eq("module_id", mod.id).eq("group_id", gid);
              if (error) return err("saveFailed");
            }
          const tagError = await sync("gw_module_companies", "company_id", coOn, picked("co"));
          if (tagError) return err("saveFailed");
        }
        m.close();
        modulesTab();
      });
    }

    view.onclick = (e) => {
      const b = e.target.closest("[data-edit]");
      if (b) dialog(modules.find((x) => x.id === b.dataset.edit));
    };
    refreshIcons();
  }

  // ================================================================ Sector（Master Manage；预设清单，例如 Operation、Admin、Account）
  async function sectorsTab() {
    const seq = routeSeq;
    const ts = (k, v) => t("admin.sector." + k, v);
    const tg = (k, v) => t("admin.groups." + k, v);
    const res = await sb.from("gw_sectors").select("*").order("sort_order").order("name");
    if (stale(seq)) return;
    if (res.error) return (view.innerHTML = empty(ts("notReady")));
    const list = res.data || [];
    const used = await sb.from("gw_group_modules").select("sector_id").not("sector_id", "is", null);
    const countOf = (id) => (used.data || []).filter((x) => x.sector_id === id).length;

    view.innerHTML = `<div class="space-y-4">
      <div class="flex items-center justify-end"><button id="sec-add" class="${btn("primary")}">${icon("plus")} ${esc(ts("add"))}</button></div>
      ${
        list.length
          ? `<div id="sec-cards" class="${cls.card} divide-y divide-slate-100 dark:divide-slate-800">${list
              .map(
                (x) => `<div data-card="${x.id}" class="flex items-center gap-3 px-3 py-3">
                  ${grip()}
                  <span class="min-w-0 flex-1 truncate font-semibold">${esc(x.name)}</span>
                  <span class="text-xs text-slate-400">${esc(ts("used", { count: countOf(x.id) }))}</span>
                  <button data-edit="${x.id}" aria-label="${esc(tg("edit"))}" class="${btn("ghost", "sm")}">${icon("pencil")}</button>
                  <button data-del="${x.id}" aria-label="${esc(tg("delete"))}" class="${btn("ghost", "sm")} text-red-600 dark:text-red-400">${icon("trash-2")}</button>
                </div>`,
              )
              .join("")}</div>`
          : empty(ts("empty"))
      }
    </div>`;
    refreshIcons();
    sortableCards($("#sec-cards"), "gw_sectors", () => toast(t("admin.company.orderSaved")));

    function dialog(x) {
      const m = modal(
        x ? ts("editTitle") : ts("addTitle"),
        `<form class="space-y-4">
          <div data-err></div>
          ${field(ts("name"), `<input name="name" required maxlength="40" value="${esc(x ? x.name : "")}" placeholder="${esc(ts("placeholder"))}" class="${cls.input}">`)}
          <div class="flex justify-end gap-2">
            <button type="button" data-cancel class="${btn("secondary")}">${esc(tg("cancel"))}</button>
            <button type="submit" class="${btn("primary")}">${esc(tg("save"))}</button>
          </div>
        </form>`,
      );
      $("[data-cancel]", m.el).onclick = m.close;
      $("[name=name]", m.el).focus();
      $("form", m.el).addEventListener("submit", async (e) => {
        e.preventDefault();
        const name = e.target.name.value.trim();
        const { error } = x ? await sb.from("gw_sectors").update({ name }).eq("id", x.id) : await sb.from("gw_sectors").insert({ name, sort_order: list.length });
        if (error) return ($("[data-err]", m.el).innerHTML = alertBox(error.code === "23505" ? ts("duplicate") : tg("saveFailed")));
        m.close();
        sectorsTab();
      });
    }

    view.onclick = async (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.id === "sec-add") return dialog(null);
      const x = list.find((y) => y.id === (b.dataset.edit || b.dataset.del));
      if (!x) return;
      if (b.dataset.edit) return dialog(x);
      if (!(await confirmDialog(ts("deleteTitle"), ts("deleteBody", { name: x.name }), tg("delete"), tg("cancel")))) return;
      const { error } = await sb.from("gw_sectors").delete().eq("id", x.id);
      if (error) setMsg(tg("saveFailed"));
      sectorsTab();
    };
  }

  // ================================================================ AI Connector（Master）：全站开关 + 全部链接
  async function connectorTab() {
    const seq = routeSeq;
    const tk = (k, v) => t("admin.connector." + k, v);
    const [setting, list] = await Promise.all([sb.from("gw_settings").select("value").eq("key", "ai_connector").maybeSingle(), sb.rpc("gw_mcp_list")]);
    if (stale(seq)) return;
    if (setting.error || list.error) return (view.innerHTML = empty(tk("notReady")));
    let on = !!setting.data?.value?.enabled;
    const links = list.data || [];
    const paint = () => {
      view.innerHTML = `<div class="space-y-4">
        <div class="${cls.card} flex items-center gap-4 p-4">
          <div class="min-w-0 flex-1"><p class="font-semibold">${esc(tk("switchTitle"))}</p><p class="text-sm text-slate-500">${esc(tk("switchDesc"))}</p></div>
          <button id="cn-switch" role="switch" aria-checked="${on}" aria-label="${esc(tk("switchTitle"))}" class="relative h-7 w-12 shrink-0 rounded-full transition-colors ${on ? "bg-brand-600" : "bg-slate-300 dark:bg-slate-700"}"><span class="absolute top-0.5 size-6 rounded-full bg-white shadow transition-all ${on ? "left-[22px]" : "left-0.5"}"></span></button>
          <span class="w-8 text-sm text-slate-500">${esc(on ? tk("on") : tk("off"))}</span>
        </div>
        <p class="text-sm font-semibold">${esc(tk("links"))} <span class="font-normal text-slate-400">(${links.filter((x) => !x.revoked_at).length})</span></p>
        ${
          links.length
            ? `<div class="${cls.card} divide-y divide-slate-100 dark:divide-slate-800">${links
                .map(
                  (x) => `<div class="flex items-center gap-3 px-3 py-3 text-sm">
                    <span class="min-w-0 flex-1"><span class="block truncate font-semibold${x.revoked_at ? " text-slate-400 line-through" : ""}">${esc(x.user_name || "—")} <span class="font-normal text-slate-500">· ${esc(x.label)}</span></span>
                    <span class="block text-xs text-slate-500">${esc(tk("created", { time: fmtDateTime(x.created_at) }))} · ${esc(x.revoked_at ? tk("revoked") : x.last_used_at ? tk("lastUsed", { time: fmtDateTime(x.last_used_at) }) : tk("neverUsed"))}</span></span>
                    ${x.revoked_at ? "" : `<button data-revoke="${x.id}" class="${btn("ghost", "sm")} text-red-600 dark:text-red-400">${esc(tk("revoke"))}</button>`}
                  </div>`,
                )
                .join("")}</div>`
            : empty(tk("empty"))
        }
      </div>`;
    };
    paint();
    view.onclick = async (e) => {
      if (e.target.closest("#cn-switch")) {
        const next = !on;
        const { error } = await sb.from("gw_settings").upsert({ key: "ai_connector", value: { enabled: next }, updated_at: new Date().toISOString(), updated_by: me.id });
        if (error) return setMsg(t("admin.groups.saveFailed"));
        on = next;
        paint();
        return toast(tk("saved"));
      }
      const b = e.target.closest("[data-revoke]");
      if (!b) return;
      if (!(await confirmDialog(tk("switchTitle"), tk("revokeConfirm"), tk("revoke"), t("admin.groups.cancel")))) return;
      const { error } = await sb.rpc("gw_mcp_revoke", { p_id: b.dataset.revoke });
      if (error) return setMsg(t("admin.groups.saveFailed"));
      connectorTab();
    };
  }

  // ================================================================ 操作记录
  async function auditTab() {
    const seq = routeSeq;
    const tl = (k, v) => t("admin.audit." + k, v);
    const PAGE = 50;
    const TARGETS = ["auth", "profiles", "roles", "role_businesses", "groups", "group_members", "companies", "business_companies", "company_mappings", "modules", "group_modules", "module_companies", "sectors", "module_members", "announcements"];
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
  // ---------------------------------------------------------------- 分页切换（#users、#groups …）
  const HANDLERS = { users: usersTab, groups: groupsTab, access: accessTab, roles: rolesTab, business: businessTab, company: companyTab, sectors: sectorsTab, modules: modulesTab, connector: connectorTab, audit: auditTab };
  // 上面三个大按钮：一样宽，当前的在正中间，其他的淡一点；点旁边的就左右滑动过去
  const SEC_W = 208, SEC_GAP = 8;
  function paintSections(activeKey) {
    const box = $("#sections");
    if (SECTIONS.length < 2) return (box.innerHTML = "");
    if (!$("#sec-track", box)) {
      box.innerHTML = `<div id="sec-track" class="flex gap-2" style="width:max-content">${SECTIONS.map(
        ([k, ic, tabs]) => `<a data-sec="${k}" href="#${tabs[0]}" style="width:${SEC_W}px" class="flex shrink-0 items-center justify-center gap-2 rounded-2xl px-4 py-3 text-sm font-semibold transition-all duration-300">${icon(ic, "size-5")}<span class="truncate">${esc(t("admin.sections." + k))}</span></a>`,
      ).join("")}</div>`;
      refreshIcons();
      requestAnimationFrame(() => ($("#sec-track").style.transition = "transform .3s ease"));
    }
    const i = SECTIONS.findIndex(([k]) => k === activeKey);
    $("#sec-track").style.transform = `translateX(${Math.round(box.clientWidth / 2 - (i * (SEC_W + SEC_GAP) + SEC_W / 2))}px)`;
    $$("#sec-track a").forEach((a) => {
      const on = a.dataset.sec === activeKey;
      a.className = `flex shrink-0 items-center justify-center gap-2 rounded-2xl px-4 py-3 text-sm font-semibold transition-all duration-300 ${
        on ? "bg-slate-900 text-white shadow-md dark:bg-white dark:text-slate-900" : "border border-slate-200 bg-white text-slate-600 opacity-40 hover:opacity-70 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300"
      }`;
      a.setAttribute("aria-current", on ? "page" : "false");
    });
  }
  let activeSection = null;
  window.addEventListener("resize", () => activeSection && paintSections(activeSection));
  async function route() {
    const hash = location.hash.slice(1) || TABS[0];
    const name = hash.split("=")[0];
    const active = HANDLERS[name] && TABS.includes(name) ? name : TABS[0];
    const section = SECTIONS.find(([, , tabs]) => tabs.includes(active));
    activeSection = section[0];
    paintSections(activeSection);
    $("#tabs").parentElement.classList.toggle("hidden", section[2].length < 2);
    $("#tabs").innerHTML = section[2]
      .map(
        (k) => `<a href="#${k}" class="rounded-lg px-3.5 py-1.5 text-sm font-medium whitespace-nowrap ${
          k === active ? "bg-white text-slate-900 shadow-sm dark:bg-slate-950 dark:text-white" : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
        }">${esc(t("admin.tabs." + k))}</a>`,
      )
      .join("");
    routeSeq++;
    setMsg("");
    view.onclick = null;
    view.onsubmit = null;
    view.onchange = null;
    view.oninput = null;
    view.innerHTML = GW.spinner();
    await HANDLERS[active]();
  }
  window.addEventListener("hashchange", route);
  route();
})();
