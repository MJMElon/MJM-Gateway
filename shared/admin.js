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
        ["userGroup", "users-round", ["users"]],
        ["master", "database", ["roles", "business", "company", "sectors", "modules", "connector"]],
        ["audit", "scroll-text", ["audit"]],
      ]
    : [
        ["userGroup", "users-round", canGroupsPage || canUsersPage || canAccessPage ? ["users"] : []],
        ...(C.can_edit_module_name ? [["master", "database", ["modules"]]] : []),
        ...(C.can_view_audit ? [["audit", "scroll-text", ["audit"]]] : []),
      ].filter(([, , tabs]) => tabs.length);
  const TABS = SECTIONS.flatMap(([, , tabs]) => tabs);

  main.innerHTML = `<div class="space-y-5">
    <div class="relative flex min-h-10 flex-col items-center gap-2 sm:flex-row sm:justify-center">
      <a href="index.html" class="inline-flex self-start sm:absolute sm:left-0 sm:self-auto items-center gap-1 text-sm text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">${icon("arrow-left")} ${esc(t("admin.backToPortal"))}</a>
      <h1 class="text-xl font-semibold sm:text-2xl">${esc(t(isSuper ? "admin.pageTitleSuper" : "admin.pageTitle"))}</h1>
    </div>
    <div id="sections" class="mx-auto w-full max-w-3xl"></div>
    <div id="panel" class="hidden rounded-3xl border border-slate-200 bg-slate-100/70 p-3 sm:p-4 dark:border-slate-800 dark:bg-slate-900/60">
      <div class="-mx-3 mb-4 overflow-x-auto px-3 sm:text-center">
        <nav id="tabs" class="inline-flex min-w-max gap-1 rounded-xl bg-slate-200/70 p-1 dark:bg-slate-800"></nav>
      </div>
      <div id="msg"></div>
      <div id="view"></div>
    </div>
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

  // ---------------------------------------------------------------- By Group / By Module 共用：上面的 Business → Company 横条
  // 选的 Business / Company 记在 localStorage（两个分页同步）；cid "" = 待分配 Company 的人（By Group）或「全部 Company」（By Module）
  const ugRemember = (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch (e) {
      /* 忽略 */
    }
  };
  const ugRecall = (k) => {
    try {
      return localStorage.getItem(k);
    } catch (e) {
      return null;
    }
  };
  const coShort = (c) => c.short_name || c.code || c.name;
  // 读回上次的选择；Company 不在这个 Business 里就选第一个 Company（allowBlank：没有 Company 时 "" 也算合法）
  function ugState(groups, companiesOf, allowBlank) {
    let gid = ugRecall("gw_ug_business");
    if (!groups.some((g) => g.id === gid)) gid = groups.length ? groups[0].id : null;
    const comps = gid ? companiesOf(gid) : [];
    let cid = ugRecall("gw_ug_company");
    if (!comps.some((c) => c.id === cid) && !(allowBlank && cid === "")) cid = comps.length ? comps[0].id : "";
    return { gid, cid };
  }
  /* 横条：Business 下拉 → Company 下拉；只有一个 Company 时直接显示名字（有 pending 选项就变成两格切换）；
     pendingLabel 有给才会多一个「待分配」选项（By Group），没有就是 By Module 的用法（没有 Company 时显示「全部 Company」） */
  function ugBar({ groups, gid, comps, cid, pendingLabel }) {
    const sel = `h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-medium text-slate-800 sm:w-56 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100`;
    const bizSel = `<select id="ug-biz" aria-label="${esc(t("admin.tabs.business"))}" class="${sel}">${groups.map((x) => `<option value="${x.id}" ${x.id === gid ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select>`;
    const pill = (text) => `<span class="inline-flex h-10 w-full items-center gap-1.5 rounded-xl sm:w-56 border border-slate-200 bg-slate-50 px-3 text-sm font-medium text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">${icon("building-2", "size-4 shrink-0 text-slate-400")}<span class="truncate">${esc(text)}</span></span>`;
    let coPart;
    if (comps.length > 1)
      coPart = `<select id="ug-co" aria-label="${esc(t("admin.tabs.company"))}" class="${sel}">${comps.map((c) => `<option value="${c.id}" ${c.id === cid ? "selected" : ""} title="${esc(c.name)}">${esc(coShort(c))}</option>`).join("")}${
        pendingLabel ? `<option value="" ${cid === "" ? "selected" : ""}>${esc(pendingLabel)}</option>` : ""
      }</select>`;
    else if (comps.length === 1 && pendingLabel) {
      const seg = (val, label, tone) => `<button type="button" data-co="${val}" aria-pressed="${cid === val}" class="rounded-lg px-3 py-1.5 text-sm font-medium whitespace-nowrap ${
        cid === val ? "bg-white text-slate-900 shadow-sm dark:bg-slate-950 dark:text-white" : tone || "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
      }">${esc(label)}</button>`;
      coPart = `<div class="inline-flex max-w-full gap-1 overflow-x-auto rounded-xl bg-slate-200/70 p-1 dark:bg-slate-800">${seg(comps[0].id, comps[0].name)}${seg("", pendingLabel, "text-amber-600 hover:text-amber-700")}</div>`;
    } else if (comps.length === 1) coPart = pill(comps[0].name);
    else coPart = pendingLabel ? `<span class="text-sm text-amber-600">${esc(t("admin.userGroups.pendingCompany"))}</span>` : pill(t("admin.access.allCompanies"));
    return `<div class="flex flex-col gap-2 px-1 pb-3 sm:flex-row sm:items-center">
      ${bizSel}<span class="hidden sm:inline">${icon("chevron-right", "size-4 shrink-0 text-slate-400")}</span>${coPart}
    </div>`;
  }
  // 横条的事件：回传 true 表示有处理（呼叫端再重画）
  function ugBarEvent(e, state, companiesOf, allowBlank) {
    const el = e.target;
    if (el.id === "ug-biz") {
      state.gid = el.value;
      ugRemember("gw_ug_business", state.gid);
      const comps = companiesOf(state.gid), last = ugRecall("gw_ug_company");
      state.cid = comps.some((c) => c.id === last) ? last : comps.length ? comps[0].id : "";
      return true;
    }
    if (el.id === "ug-co" || (el.closest && el.closest("[data-co]"))) {
      state.cid = el.id === "ug-co" ? el.value : el.closest("[data-co]").dataset.co;
      if (!allowBlank && state.cid === "" && companiesOf(state.gid).length) state.cid = companiesOf(state.gid)[0].id;
      ugRemember("gw_ug_company", state.cid);
      return true;
    }
    return false;
  }
  const byModName = (a, b) => (a.name || "").localeCompare(b.name || "");
  // Super Admin 自动拥有所有模块（资料库 gw__effective_module_ids 也是这样算），画面上一律显示成有权限 + Admin
  const isSuperUser = (u) => !!u && u.role === "super_admin";
  const SUPER_ROW = Object.freeze({ is_admin: true, auto: true });
  // 模块图示上的小标记：右下绿勾 = 有权限；右上蓝盾 = 这个模块的 Admin
  const accessMark = `<span class="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full bg-emerald-500 text-white ring-2 ring-white dark:ring-slate-800">${icon("check", "size-2.5")}</span>`;
  const adminMark = () => `<span data-admin-mark title="${esc(t("admin.userWindow.adminOf"))}" class="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-sky-500 text-white ring-2 ring-white dark:ring-slate-800">${icon("shield-check", "size-2.5")}</span>`;
  // 图示下面的名字：最多两行、不在字中间断开
  const tileName = (name, extra) => `<span class="line-clamp-2 w-full text-center text-xs leading-tight font-medium [overflow-wrap:normal] [word-break:normal] ${extra || ""}">${esc(name)}</span>`;
  // 这个 Business（+ Company）里能用的模块：标到 Business、启用中；模块有标 Company 的话，选的 Company 要在里面（"" = 只看没标 Company 的）
  const modulesForLine = (ctx, gid, cid) =>
    ctx.gm
      .filter((x) => x.group_id === gid)
      .map((x) => ctx.mods.find((m) => m.id === x.module_id))
      .filter((mod) => mod && mod.is_active)
      .filter((mod) => {
        const tags = ctx.coTags.filter((x) => x.module_id === mod.id);
        return !tags.length || tags.some((x) => x.company_id === cid);
      })
      .sort(byModName);

  // ================================================================ 模块权限（By Module）
  /* 上面横条选 Business → Company（跟 By Group 同一个，选择互通）
     下面列出这个 Business ＋ Company 能用、而且我管得到的模块（图示、名称、几个人有权限）
     点模块 → 原地展开（一次一个）：
       第一区：在这个 Business ＋ Company 里、已经有这个模块的人（Access / Admin 两个勾，规则跟用户资料窗一样）
       第二区：在这里、还没有这个模块的人（按钮开 Access）；
               搜寻框也会找不在这里的人（Other users），确认后依序：加进 Business → 加进 Company → 开 Access。 */
  async function modulesView(host, shared) {
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
    const inCompany = (uid, gid, cid) => memberCos.some((x) => x.user_id === uid && x.group_id === gid && x.company_id === cid);
    const locked = (u) => u.id === me.id || u.role === "super_admin";
    const { state, groups, companiesOf } = shared;
    const match = (u, q) => !q || [u.full_name, u.email, u.user_code].filter(Boolean).join(" ").toLowerCase().includes(q);
    const byName = (a, b) => (a.full_name || "").localeCompare(b.full_name || "");
    let openMid = null;
    let query = shared.q || "";

    const line = () => ({ g: groups.find((x) => x.id === state.gid) || null, c: companiesOf(state.gid).find((x) => x.id === state.cid) || null });
    const inLine = (u, l) => ctx.inGroup(u.id, l.g.id) && (!l.c || inCompany(u.id, l.g.id, l.c.id));
    // 这条线上我管得到的模块
    // 启用中的 Super Admin：每个模块的「有权限」名单最上面都列出来（不分 Business / Company）
    const supers = () => ctx.users.filter((u) => isSuperUser(u) && u.status === "active").sort(byName);
    const modsHere = () => (state.gid ? modulesForLine(ctx, state.gid, state.cid).filter((mod) => ctx.managedPairs.some((p) => p.group_id === state.gid && p.module_id === mod.id)) : []);

    const person = (u) => `<div class="min-w-0 flex-1">
        <p class="truncate text-sm font-medium">${esc(u.full_name)}${u.status === "disabled" ? ` ${badge(ta("disabled"), "red")}` : ""}</p>
        <p class="truncate text-xs text-slate-500">${esc(u.email)}${u.user_code ? ` · <span class="font-mono">${esc(u.user_code)}</span>` : ""}</p>
      </div>`;
    const avatar = (u) => `<span class="flex size-9 shrink-0 items-center justify-center rounded-full bg-slate-200 text-sm font-semibold dark:bg-slate-700">${esc((u.full_name || "?").slice(0, 1))}</span>`;
    const listBox = (inner, attrs) => `<div ${attrs || ""} class="max-h-72 divide-y divide-slate-100 overflow-y-auto overscroll-contain rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-800">${inner}</div>`;
    const none = (text) => `<p class="px-3 py-6 text-center text-xs text-slate-400">${esc(text)}</p>`;
    const head = (title, n) => `<p class="mb-1.5 flex items-center gap-2 text-xs font-bold tracking-wider text-slate-500 uppercase">${esc(title)}<span class="rounded-full bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold text-slate-500 normal-case dark:bg-slate-800">${n}</span></p>`;

    // ---------------- 整页：横条 + 模块手风琴
    function draw() {
      const l = line();
      const mods = modsHere();
      if (!mods.some((m) => m.id === openMid)) openMid = null;
      const here = l.g ? ctx.users.filter((u) => inLine(u, l)) : [];
      const card = (mod) => {
        const open = mod.id === openMid;
        const n = supers().length + here.filter((u) => !isSuperUser(u) && ctx.rows.has(u.id + ":" + mod.id)).length;
        return `<div data-mod-card="${mod.id}" class="${open ? "bg-slate-50/70 dark:bg-slate-800/40" : ""}">
          <button data-open-mod="${mod.id}" aria-expanded="${open}" class="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800/60">
            ${modLogo(mod, "size-12")}
            <span class="min-w-0 flex-1">
              <span class="block truncate font-semibold">${esc(mod.name)}</span>
              <span class="block text-xs text-slate-500">${esc(ta("userCount", { count: n }))}</span>
            </span>
            <span class="shrink-0 text-slate-400">${icon(open ? "chevron-up" : "chevron-down", "size-4")}</span>
          </button>
          ${
            open
              ? `<div class="space-y-4 px-4 pt-1 pb-4">
                  <div id="bm-s1"></div>
                  <div class="space-y-3">
                    <div id="bm-s2-head"></div>
                    <div class="relative">
                      <span class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400">${icon("search")}</span>
                      <input id="bm-q" type="search" value="${esc(query)}" placeholder="${esc(ta("searchPlaceholder"))}" class="${cls.input} pl-9">
                    </div>
                    <div id="bm-s2"></div>
                  </div>
                </div>`
              : ""
          }
        </div>`;
      };
      host.innerHTML = `<div class="${cls.card} p-3">
        ${groups.length && l.g ? `<div class="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-800">${mods.map(card).join("") || none(ta("noModulesHere"))}</div>` : empty(ta("empty"))}
      </div>`;
      refreshIcons();
      if (openMid) drawSections();
    }

    function drawSections() {
      const l = line();
      const mid = openMid;
      const gid = l.g.id;
      const q = query.trim().toLowerCase();
      const here = ctx.users.filter((u) => inLine(u, l)).sort(byName);
      const plain = here.filter((u) => !isSuperUser(u));
      const has = [...supers(), ...plain.filter((u) => ctx.rows.has(u.id + ":" + mid))];
      const not = plain.filter((u) => !ctx.rows.has(u.id + ":" + mid));
      // 第一区：Access / Admin 两个勾（跟用户资料窗同一套规则）
      $("#bm-s1").innerHTML = head(ta("hasAccess"), has.length) +
        listBox(
          has
            .map((u) => {
              const sup = isSuperUser(u);
              const row = sup ? SUPER_ROW : ctx.rows.get(u.id + ":" + mid);
              const canAdm = !sup && ctx.canAdmin(u, gid, mid);
              const canAcc = !sup && ctx.canAccess(u, gid, mid) && !(row.is_admin && !canAdm);
              return `<div data-super-row="${sup ? u.id : ""}" class="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 ${u.status === "disabled" ? "opacity-60" : ""}">
                ${avatar(u)}${person(u)}${sup ? badge(t("admin.users.roles.super_admin"), "red") : ""}
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
        const others = ctx.users.filter((u) => u.status === "active" && !isSuperUser(u) && !inLine(u, l) && match(u, q)).sort(byName);
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
      // 人数变了 → 卡片标题的人数也更新
      const n = has.length;
      const title = $(`[data-open-mod="${mid}"] .text-xs`);
      if (title) title.textContent = ta("userCount", { count: n });
      refreshIcons();
    }

    // 加不在这个 Business / Company 的人：先确认，再依序 Business → Company → 模块 Access
    async function addOutsider(uid) {
      const l = line();
      const mod = ctx.mods.find((m) => m.id === openMid);
      const u = ctx.users.find((x) => x.id === uid);
      const g = l.g, c = l.c;
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

    host.onclick = async (e) => {
      const b = e.target.closest("button");
      if (!b || b.disabled) return;
      if (b.dataset.openMod) return ((openMid = openMid === b.dataset.openMod ? null : b.dataset.openMod), (query = ""), draw());
      if (b.dataset.grant) {
        b.disabled = true;
        await saveAccess(ctx, b.dataset.grant, openMid, true, false);
        return drawSections();
      }
      if (b.dataset.outsider) return addOutsider(b.dataset.outsider);
    };
    host.onchange = async (e) => {
      await onTick(ctx, e, drawSections);
    };
    host.oninput = (e) => {
      if (e.target.id !== "bm-q") return;
      query = shared.q = e.target.value;
      drawSections();
    };
    shared.refresh = draw;
    draw();
  }

  // ---------------------------------------------------------------- 模块小图示、用户资料窗（用户名单、群组管理共用）
  const modLogo = (m, size) =>
    m.image_url
      ? `<img src="${esc(m.image_url)}" alt="${esc(m.name)}" title="${esc(m.name)}" class="${size || "size-5"} shrink-0 rounded-md object-cover">`
      : `<span title="${esc(m.name)}" class="flex ${size || "size-5"} shrink-0 items-center justify-center rounded-md bg-brand-50 text-brand-600 dark:bg-brand-700/20 dark:text-brand-100">${moduleIcon(m.icon, /size-1[0-9]/.test(size || "") ? "size-6" : /size-[89]/.test(size || "") ? "size-4" : "size-3")}</span>`;
  // 我能不能管理某模块里的用户权限（super_admin、模块 Admin、角色有「管理模块用户权限」）
  const canManageModule = (mid) => isSuper || (me.adminModuleIds || []).includes(mid) || (C.can_manage_module_access && (me.roleModules || []).includes(mid));

  /* 用户资料窗：
       标题 = 名字；下面两行 Login email、User ID
       每个 Business 一条可以收合的横条（像首页的区块标题）：Business 名称 + Company 选择（多个 Company 才有下拉；一个就直接显示）
       展开 = 这个 Business（和选的 Company）有标到的模块图示；点图示 → 下面开一小块：Access / Admin 勾选（Diesel 多 Cash Claim / Report）
       能不能改看角色：super_admin、角色有加 / 移除 / 设定 Admin 的 Business、或是模块 Admin；自己和 Super Admin 只能看。 */
  async function userWindow(uid, onClose) {
    const tu = (k, v) => t("admin.userWindow." + k, v);
    const ta = (k, v) => t("admin.users.accessDialog." + k, v);
    const m = modal("", GW.spinner(), { wide: true, onClose });
    const [{ data: u }, { data: mems }, { data: groups }, { data: companies }, { data: mm }, { data: mods }, { data: gxRows }, { data: mcs0 }, { data: bizCos }] = await Promise.all([
      sb.from("gw_profiles").select("id, full_name, email, status, role, role_id, user_code").eq("id", uid).maybeSingle(),
      sb.from("gw_group_members").select("group_id").eq("user_id", uid),
      sb.from("gw_groups").select("id, name").order("sort_order").order("name"),
      sb.from("gw_companies").select("id, name, short_name, code").order("sort_order").order("name"),
      sb.from("gw_module_members").select("user_id, module_id, is_admin").eq("user_id", uid),
      sb.from("gw_modules").select("id, code, name, icon, image_url, is_active").order("sort_order").order("name"),
      sb.from("gw_group_modules").select("group_id, module_id"),
      sb.from("gw_member_companies").select("group_id, company_id").eq("user_id", uid),
      sb.from("gw_business_companies").select("group_id, company_id"),
    ]);
    if (!u) return m.close();
    const h = m.el.parentElement.querySelector("h2");
    if (h) h.textContent = u.full_name;
    const coById = new Map((companies || []).map((c) => [c.id, c]));
    const modById = new Map((mods || []).map((x) => [x.id, x]));
    const myGroups = (mems || []).map((x) => x.group_id);
    // 这个人所在的 Business（照 Business 的排序）
    const bizList = (groups || []).filter((g) => myGroups.includes(g.id));
    const mcs = mcs0 || []; // 这个人的 Company（「+」弹窗会改）
    const cosIn = (gid) => mcs.filter((x) => x.group_id === gid).map((x) => coById.get(x.company_id)).filter(Boolean);
    const superU = isSuperUser(u);
    const locked = u.id === me.id || superU;
    const rowOf = (mid) => (superU ? SUPER_ROW : ctx.rows.get(u.id + ":" + mid));
    const canEdit =
      !locked &&
      (isSuper ||
        myGroups.some((gid) => ["can_grant_module", "can_revoke_module", "can_set_module_admin"].some((f) => me.bizCan(gid, f))) ||
        (gxRows || []).some((g) => myGroups.includes(g.group_id) && canManageModule(g.module_id)) ||
        (me.adminModuleIds || []).some((mid) => (gxRows || []).some((g) => myGroups.includes(g.group_id) && g.module_id === mid)));
    let ctx = null; // loadAccess()：权限规则 + 模块 × Company 标签
    // 画面状态：哪些 Business 展开、每个 Business 选的 Company、每个 Business 点开的模块
    const expanded = new Set(bizList.length === 1 ? bizList.map((g) => g.id) : bizList.slice(0, 1).map((g) => g.id));
    const selCo = new Map(bizList.map((g) => [g.id, (cosIn(g.id)[0] || {}).id || ""]));
    const openMod = new Map();

    // 这个 Business（+ 选的 Company）里要显示的模块：标到这个 Business、启用中；模块有标 Company 的话，选的 Company 要在里面
    function modulesFor(gid) {
      const cid = selCo.get(gid);
      return (gxRows || [])
        .filter((x) => x.group_id === gid)
        .map((x) => modById.get(x.module_id))
        .filter((mod) => mod && mod.is_active)
        .filter((mod) => {
          const tags = ctx ? ctx.coTags.filter((x) => x.module_id === mod.id) : [];
          return !tags.length || tags.some((x) => x.company_id === cid);
        })
        .sort(byModName);
    }
    const coLabel = (c) => c.short_name || c.code || c.name;

    function companyPicker(gid) {
      const list = cosIn(gid);
      if (!list.length) return badge(tu("noCompany"), "amber");
      const pill = "inline-flex max-w-[14rem] min-w-0 items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-0.5 text-xs font-medium text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300";
      if (list.length === 1) return `<span class="${pill}" title="${esc(list[0].name)}">${icon("building-2", "size-3.5 shrink-0")}<span class="truncate">${esc(coLabel(list[0]))}</span></span>`;
      return `<select data-co-pick="${gid}" class="h-7 max-w-[12rem] rounded-full border border-slate-200 bg-white px-2 text-xs font-medium text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">${list
        .map((c) => `<option value="${c.id}" ${selCo.get(gid) === c.id ? "selected" : ""}>${esc(coLabel(c))}</option>`)
        .join("")}</select>`;
    }

    // 点开的模块：Access / Admin 勾选（规则同 By Module）
    function panel(gid, mod) {
      const row = rowOf(mod.id);
      const canAdm = !superU && ctx.canAdmin(u, gid, mod.id) && !!row;
      const canAcc = !superU && ctx.canAccess(u, gid, mod.id) && !(row && row.is_admin && !ctx.canAdmin(u, gid, mod.id));
      return `<div data-panel="${mod.id}" class="mt-2 rounded-xl border border-slate-200 bg-slate-50/70 p-3 dark:border-slate-700 dark:bg-slate-800/60">
        <div class="flex flex-wrap items-center gap-3">
          ${modLogo(mod, "size-10")}
          <p class="min-w-0 flex-1 truncate text-sm font-semibold">${esc(mod.name)}</p>
          <span class="flex gap-4">
            ${tick(`data-acc="${u.id}:${mod.id}:access"`, !!row, canAcc, ta("access"))}
            ${tick(`data-acc="${u.id}:${mod.id}:admin"`, row && row.is_admin, canAdm, ta("admin"))}
          </span>
        </div>
        ${!row && canEdit ? `<p class="mt-1.5 text-xs text-slate-500">${esc(tu("tickAccessFirst"))}</p>` : ""}
      </div>`;
    }

    function bizBar(g) {
      const on = expanded.has(g.id);
      const list = ctx ? modulesFor(g.id) : null;
      const tile = (mod) => {
        const row = rowOf(mod.id);
        const active = openMod.get(g.id) === mod.id;
        return `<button type="button" data-tile="${g.id}:${mod.id}" title="${esc(mod.name)}" class="relative flex w-28 min-w-[6rem] flex-col items-center gap-1.5 rounded-xl p-2 text-center transition-colors ${
          active ? "bg-white shadow-sm ring-2 ring-brand-500 dark:bg-slate-900" : "hover:bg-white/70 dark:hover:bg-white/5"
        }">
          <span class="relative">${modLogo(mod, "size-12")}${row ? accessMark : ""}${row && row.is_admin ? adminMark() : ""}</span>
          ${tileName(mod.name, row ? "text-slate-800 dark:text-slate-100" : "text-slate-500")}
        </button>`;
      };
      const body = !on
        ? ""
        : `<div class="border-t border-slate-200/80 px-3 pt-2 pb-3 dark:border-slate-700">${
            !list
              ? GW.spinner()
              : list.length
                ? `<div class="flex flex-wrap gap-1">${list.map(tile).join("")}</div>
                   ${openMod.has(g.id) && list.some((x) => x.id === openMod.get(g.id)) ? panel(g.id, modById.get(openMod.get(g.id))) : `<p class="mt-1 px-1 text-xs text-slate-400">${esc(tu("clickModule"))}</p>`}`
                : `<p class="py-3 text-center text-sm text-slate-400">${esc(tu("noModulesHere"))}</p>`
          }</div>`;
      return `<div data-biz="${g.id}" class="rounded-2xl border border-slate-200 bg-slate-50/60 dark:border-slate-700 dark:bg-slate-800/40">
        <div class="flex min-w-0 items-center gap-2 px-3 py-2">
          <h3 class="min-w-0 truncate text-[15px] font-semibold tracking-tight text-slate-800 dark:text-slate-100">${esc(g.name)}</h3>
          ${companyPicker(g.id)}
          ${isSuper || me.bizCan(g.id, "can_add_business_user") ? `<button type="button" data-add-co="${g.id}" title="${esc(tu("companies", { business: g.name }))}" aria-label="${esc(tu("companies", { business: g.name }))}" class="ml-auto flex size-7 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-white dark:hover:bg-white/10">${icon("plus", "size-4")}</button>` : ""}
          <button type="button" data-toggle="${g.id}" aria-expanded="${on}" aria-label="${esc(t(on ? "home.collapse" : "home.expand"))}" class="${isSuper || me.bizCan(g.id, "can_add_business_user") ? "" : "ml-auto"} flex size-7 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-white dark:hover:bg-white/10">${icon(on ? "chevron-up" : "chevron-down", "size-4")}</button>
        </div>${body}</div>`;
    }

    function draw() {
      const note = superU ? tu("superNote") : locked ? tu("selfNote") : !canEdit ? tu("viewOnlyNote") : "";
      m.el.innerHTML = `<div class="space-y-4">
        <div class="flex items-start gap-3">
          <span class="flex size-14 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xl font-semibold dark:bg-slate-700">${esc(u.full_name.slice(0, 1))}</span>
          <dl class="grid min-w-0 flex-1 grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
            <dt class="text-slate-500">${esc(tu("loginEmail"))}</dt><dd class="truncate font-medium">${esc(u.email)}</dd>
            <dt class="text-slate-500">${esc(tu("userId"))}</dt><dd class="font-mono font-medium">${esc(u.user_code || "—")}</dd>
          </dl>
        </div>
        ${note ? `<p class="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">${esc(note)}</p>` : ""}
        ${bizList.length ? `<div class="space-y-2">${bizList.map(bizBar).join("")}</div>` : empty(tu("noBusiness"))}
        <div class="flex justify-end gap-2">
          ${isSuper ? `<button data-edit class="${btn("secondary")}">${icon("pencil", "size-4")} ${esc(t("admin.users.edit"))}</button>` : ""}
          <button data-done class="${btn("primary")}">${esc(t("admin.users.done"))}</button>
        </div>
      </div>`;
      refreshIcons();
    }

    m.el.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if ("done" in b.dataset) return m.close();
      // Edit：开资料表单；存好后关掉这个窗、重新开（资料和名单都会更新）
      if ("edit" in b.dataset) return userDialog(u, () => (m.close(), userWindow(uid, onClose)));
      if (b.dataset.toggle) {
        expanded.has(b.dataset.toggle) ? expanded.delete(b.dataset.toggle) : expanded.add(b.dataset.toggle);
        return draw();
      }
      if (b.dataset.tile) {
        const [gid, mid] = b.dataset.tile.split(":");
        openMod.get(gid) === mid ? openMod.delete(gid) : openMod.set(gid, mid);
        return draw();
      }
      if (b.dataset.addCo) return companiesPopup(b.dataset.addCo);
    });
    // 「+」：这个 Business 连结的全部 Company，勾 = 这个人在那个 Company（gw_member_companies）；改了后面的窗马上更新
    function companiesPopup(gid) {
      const g = bizList.find((x) => x.id === gid);
      const all = (bizCos || []).filter((x) => x.group_id === gid).map((x) => coById.get(x.company_id)).filter(Boolean);
      const pm = modal(tu("companies", { business: g.name }), "");
      const paint = () => {
        pm.el.innerHTML = all.length
          ? `<div class="divide-y divide-slate-100 rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-800">${all
              .map((c) => {
                const on = mcs.some((x) => x.group_id === gid && x.company_id === c.id);
                return `<label class="flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm hover:bg-slate-50 dark:hover:bg-slate-800/60">
                  <input type="checkbox" data-co-tick="${c.id}" ${on ? "checked" : ""} class="size-4 accent-emerald-600">
                  <span class="min-w-0 flex-1"><span class="block truncate font-medium">${esc(c.name)}</span>${coLabel(c) !== c.name ? `<span class="block text-xs text-slate-500">${esc(coLabel(c))}</span>` : ""}</span>
                </label>`;
              })
              .join("")}</div>`
          : empty(t("admin.userGroups.noCompanies"));
      };
      paint();
      pm.el.addEventListener("change", async (e) => {
        const box = e.target.closest("[data-co-tick]");
        if (!box) return;
        const cid = box.dataset.coTick;
        box.disabled = true;
        const { error } = box.checked
          ? await sb.from("gw_member_companies").insert({ group_id: gid, user_id: uid, company_id: cid })
          : await sb.from("gw_member_companies").delete().eq("group_id", gid).eq("user_id", uid).eq("company_id", cid);
        if (error) {
          toast(t("admin.groups.saveFailed"));
          return paint();
        }
        if (box.checked) mcs.push({ group_id: gid, company_id: cid });
        else mcs.splice(mcs.findIndex((x) => x.group_id === gid && x.company_id === cid), 1);
        // 选的 Company 被拿掉了 → 换成第一个
        if (!cosIn(gid).some((c) => c.id === selCo.get(gid))) ((selCo.set(gid, (cosIn(gid)[0] || {}).id || "")), openMod.delete(gid));
        paint();
        draw();
      });
    }
    m.el.addEventListener("change", async (e) => {
      const box = e.target;
      if (box.dataset.coPick) {
        selCo.set(box.dataset.coPick, box.value);
        openMod.delete(box.dataset.coPick);
        return draw();
      }
      await onTick(ctx, e, draw);
    });
    draw();
    ctx = await loadAccess();
    draw();
  }

  /* 用户资料表单（Full User List 的「Add」、用户资料窗的「Edit」共用）：名字、Email、Business、角色，
     super_admin 还可以勾「Become super admin」（= role super_admin；勾了角色下拉就不用选） */
  async function userDialog(user, onSaved) {
    const tu = (k, v) => t("admin.users." + k, v);
    const [groups, roles, companies, bizCo, mems] = await Promise.all([
      sb.from("gw_groups").select("id, name").order("sort_order").order("name"),
      sb.from("gw_roles").select("id, name").order("sort_order").order("name"),
      sb.from("gw_companies").select("id, name").order("sort_order").order("name"),
      sb.from("gw_business_companies").select("group_id, company_id"),
      user ? sb.from("gw_group_members").select("group_id").eq("user_id", user.id) : Promise.resolve({ data: [] }),
    ]).then((r) => r.map((x) => x.data || []));
    const roleValue = (u) => (u.role === "super_admin" ? "super_admin" : u.role_id || "user");
    const roleOptions = [["user", tu("roles.user")], ...roles.map((r) => [r.id, r.name])];
    const toRole = (v) => (v === "super_admin" ? { role: "super_admin", role_id: null } : v === "user" ? { role: "user", role_id: null } : { role: "user", role_id: v });
    const selected = new Set(mems.map((x) => x.group_id));
    const companiesIn = (gid) => companies.filter((c) => bizCo.some((l) => l.group_id === gid && l.company_id === c.id));
    const isSelf = !!user && user.id === me.id;
    const wasSuper = !!user && user.role === "super_admin";
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
        ${field(tu("role"), select("role", roleOptions, user && !wasSuper ? roleValue(user) : "user", isSelf || wasSuper ? "disabled" : ""))}
        ${
          isSuper
            ? `<label class="flex items-start gap-2.5 rounded-xl border border-slate-200 px-3 py-2.5 dark:border-slate-700 ${isSelf ? "opacity-60" : "cursor-pointer"}">
                <input type="checkbox" name="super" ${wasSuper ? "checked" : ""} ${isSelf ? "disabled" : ""} class="mt-0.5 size-4 accent-red-600">
                <span class="min-w-0"><span class="block text-sm font-medium">${esc(tu("becomeSuper"))}</span><span class="block text-xs text-slate-500">${esc(tu("becomeSuperHint"))}</span></span>
              </label>`
            : ""
        }
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
    const f0 = $("form", m.el);
    // 勾了 Become super admin → 角色下拉不用选
    if (f0.super) f0.super.addEventListener("change", () => (f0.role.disabled = isSelf || f0.super.checked));
    // 新增用户：选了 Business，Company 才有得选（只列这个 Business 的 Company）
    if (!user)
      f0.business.addEventListener("change", () => {
        const list = companiesIn(f0.business.value);
        f0.company.innerHTML = [["", "—"], ...list.map((c) => [c.id, c.name])].map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("");
      });
    $("[data-cancel]", m.el).onclick = m.close;
    f0.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target;
      const submit = $("button[type=submit]", f);
      submit.disabled = true;
      if (!user) selected.clear();
      if (!user && f.business.value) selected.add(f.business.value);
      const makeSuper = !!(f.super && f.super.checked);
      const roleInput = isSelf ? toRole(roleValue(user)) : makeSuper ? toRole("super_admin") : toRole(f.role.value || "user");
      const input = { full_name: f.full_name.value.trim(), ...roleInput, group_ids: [...selected] };
      const r = user ? await updateUser(user.id, input, [...mems.map((x) => x.group_id)]) : await invoke("gw-admin", { action: "create_user", user: { ...input, email: f.email.value.trim() } });
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
      if (onSaved) onSaved();
    });
  }

  // 编辑用户：直接以 super_admin 身份写入，RLS 与 gw_profiles_guard 检查权限
  async function updateUser(id, input, beforeGroups) {
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
    const before = new Set(beforeGroups);
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

  // ================================================================ 用户名单（super_admin 可以管理；角色有「看名单」只能看，而且只看得到它负责的 Business 的人）
  async function allUsersView(host, shared) {
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
    const filter = { q: shared.q || "", role: "", status: "", module: "" };

    if (stale(seq)) return;
    host.innerHTML = `<div class="space-y-4">
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
        </div>
      </div>
      ${isSuper ? `<p class="px-1 text-xs text-slate-500">${icon("info", "mr-1 inline size-3.5 align-text-bottom")}${esc(tu("externalSource"))}</p>` : ""}
      <div id="list"></div>
    </div>`;

    function drawList() {
      const q = filter.q.trim().toLowerCase();
      const list = users.filter(
        (u) =>
          (!q || u.full_name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q) || (u.user_code || "").toLowerCase().includes(q)) &&
          (!filter.role || roleValue(u) === filter.role) &&
          (!filter.status || u.status === filter.status) &&
          (!filter.module || isSuperUser(u) || modsOf(u.id).some((r) => r.module_id === filter.module)),
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
                  ${
                    isSuperUser(u)
                      ? `<div class="mt-1.5">${badge(tu("allModules"), "green")}</div>`
                      : modsOf(u.id).length
                        ? `<div class="mt-1.5 flex flex-wrap gap-1">${modsOf(u.id).map((r) => modLogo(modById.get(r.module_id), "size-5")).join("")}</div>`
                        : ""
                  }
                </div>
                <div class="flex flex-wrap gap-1.5">
                  <button data-window="${u.id}" class="${btn("ghost", "sm")}">${icon("search")} ${esc(tu("details"))}</button>
                  ${
                    isSuper && u.id !== me.id
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

    async function drawListFresh() {
      const { data } = await sb.from("gw_profiles").select("*").order("full_name");
      if (data) users.splice(0, users.length, ...data);
      if (!stale(seq)) drawList();
    }
    if (filter.q) $("#q").value = filter.q;
    $("#q").addEventListener("input", (e) => ((filter.q = shared.q = e.target.value), drawList()));
    $("#role-filter").addEventListener("change", (e) => ((filter.role = e.target.value), drawList()));
    $("#module-filter").addEventListener("change", (e) => ((filter.module = e.target.value), drawList()));
    $("#status").addEventListener("change", (e) => ((filter.status = e.target.value), drawList()));
    $("#list").addEventListener("click", async (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      // 「查看」：开用户资料窗（跟 By Group 点名字一样）；里面的 Edit 改完资料会重画名单
      if (b.dataset.window) return userWindow(b.dataset.window, () => (location.hash.replace("#", "") === "users" || !location.hash) && drawListFresh());
      const user = users.find((u) => u.id === b.dataset.status);
      if (!user) return;
      b.disabled = true;
      const status = user.status === "active" ? "disabled" : "active";
      const r = await invoke("gw-admin", { action: "set_status", id: user.id, status });
      if (r && r.ok) setMsg(status === "disabled" ? tu("disabledOk") : tu("enabledOk"), "green");
      else setMsg(tu("errors." + ((r && r.error) || "forbidden")));
      drawListFresh();
    });
    shared.refresh = () => {};
    drawList();
  }

  /* User Group Manage（只限 super_admin）
     左边：还没有任何群组的人（Pending assignment），拖到右边的群组卡片就加入；手机可点名字选群组。
     右边：每个群组一张卡片：成员（× 移出）＋ Group Access（这个群组能看到哪些 App）。 */
  // ================================================================ 群组列表（User & Group Manage）
  // Business（gw_groups）→ Company（gw_companies，经由 gw_business_companies 连结）；把左边的人拖进某个 Business 底下的某个 Company
  async function peopleView(host, shared) {
    const seq = routeSeq;
    const tg = (k, v) => t("admin.groups." + k, v);
    const tu2 = (k, v) => t("admin.userGroups." + k, v);
    const [allGroups, users, members, memberCos, companies, grantRows, links, mods, ctx, hiddenSetting] = await Promise.all([
      sb.from("gw_groups").select("*").order("sort_order").order("name"),
      sb.from("gw_profiles").select("id, full_name, email, status, role").order("full_name"),
      sb.from("gw_group_members").select("group_id, user_id"),
      sb.from("gw_member_companies").select("group_id, user_id, company_id"),
      sb.from("gw_companies").select("*").eq("is_active", true).order("sort_order").order("name"),
      sb.from("gw_group_modules").select("group_id, module_id"),
      sb.from("gw_business_companies").select("group_id, company_id"),
      sb.from("gw_modules").select("id, code, name, icon, image_url, is_active").order("sort_order").order("name"),
      loadAccess(), // 模块权限的规则和现况（拖模块到人名上开权限用）
      sb.from("gw_settings").select("value").eq("key", "hidden_users").maybeSingle(), // 从待分配名单隐藏的帐号（全站设定，super_admin 才能改）
    ]).then((r) => r.map((x) => (Array.isArray(x) || !("data" in x) ? x : x.data || [])));
    if (stale(seq)) return;
    const hidden = new Set(Array.isArray(hiddenSetting && hiddenSetting.value && hiddenSetting.value.ids) ? hiddenSetting.value.ids : []);
    let showHidden = false;
    const modById = new Map(mods.map((x) => [x.id, x]));
    // 这个人在这个 Business 里可以用的模块（小图示）
    const logosIn = (uid, gid) =>
      (isSuperUser(userById.get(uid))
        ? grantRows.filter((g) => g.group_id === gid && modById.has(g.module_id) && modById.get(g.module_id).is_active !== false).map((g) => ({ user_id: uid, module_id: g.module_id, is_admin: true }))
        : [...ctx.rows.values()].filter((r) => r.user_id === uid && modById.has(r.module_id) && grantRows.some((g) => g.group_id === gid && g.module_id === r.module_id))
      )
        .map((r) => ({ r, mod: modById.get(r.module_id) }))
        .sort((a, b) => byModName(a.mod, b.mod))
        .map(({ r, mod }) =>
          r.is_admin
            ? `<span class="relative inline-flex" title="${esc(mod.name)} · ${esc(t("admin.userWindow.adminOf"))}">${modLogo(mod, "size-5")}<span data-admin-mark class="absolute -top-1 -right-1 flex size-3 items-center justify-center rounded-full bg-sky-500 text-white ring-1 ring-white dark:ring-slate-800">${icon("shield-check", "size-2")}</span></span>`
            : modLogo(mod, "size-5"),
        )
        .join("");

    // 角色功能：加人（拖拉、点名字）、移出、模块权限
    const canAdd = isSuper || C.can_add_business_user; // 任一 Business 可以加人 → 显示左边名单
    const canAddTo = (gid) => me.bizCan(gid, "can_add_business_user");
    const canRemoveFrom = (gid) => me.bizCan(gid, "can_remove_business_user");
    const { state, groups, companiesOf } = shared;
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
    let query = shared.q || "";
    const groupsOf = (uid) => allGroups.filter((g) => memberSet.has(g.id + ":" + uid));
    // 我在这个 Business 能不能开这个模块的权限（给谁再看 ctx.canGrant）
    const canGrantMod = (gid, mid) => isSuper || ctx.managedPairs.some((p) => p.group_id === gid && p.module_id === mid);
    let sortables = [];

    // 左边待分配名单的名片（名字 + Email）；super_admin 可以把帐号从待分配隐藏（eye-off）/ 放回去（eye）
    const eyeBtn = (u, unhide) =>
      isSuper
        ? `<button type="button" data-${unhide ? "unhide" : "hide"}="${u.id}" title="${esc(tu2(unhide ? "unhide" : "hide"))}" aria-label="${esc(tu2(unhide ? "unhide" : "hide"))}" class="no-drag rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-700">${icon(unhide ? "eye" : "eye-off", "size-4")}</button>`
        : "";
    const chip = (u, unhide) => `<div data-user="${u.id}" class="gw-user flex ${canAdd && !unhide ? "cursor-grab" : "cursor-pointer"} items-center gap-2 rounded-xl border border-white/70 bg-white/80 px-2.5 py-1.5 text-sm shadow-sm dark:border-slate-700 dark:bg-slate-800 ${u.status === "disabled" ? "opacity-50" : ""}">
        <span class="flex size-9 shrink-0 items-center justify-center rounded-full bg-slate-200 text-sm font-semibold dark:bg-slate-700">${esc(u.full_name.slice(0, 1))}</span>
        <span class="min-w-0 flex-1"><span class="block truncate font-medium">${esc(u.full_name)}</span><span class="block truncate text-xs text-slate-500">${esc(u.email)}</span></span>
        ${eyeBtn(u, unhide)}
      </div>`;
    // 右边名单的一行：名字、Email、他在这个 Business 可以用的模块小图示、拿掉的 ✕
    function row(u, g, c) {
      // ✕ = 从这个 Business（和它底下的 Company）拿掉 → 没有别的 Business 的话就回到待分配名单
      const x = canRemoveFrom(g.id)
        ? `<button data-out-biz="${g.id}:${u.id}" aria-label="${esc(tu2("removeMember"))}" title="${esc(tu2("removeMember"))}" class="no-drag rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600">${icon("x")}</button>`
        : "";
      return `<div data-user="${u.id}" data-drop-user="${u.id}" class="gw-user flex cursor-pointer items-center gap-3 rounded-xl border border-white/70 bg-white/80 px-3 py-2 text-sm shadow-sm hover:bg-white dark:border-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700/80 ${u.status === "disabled" ? "opacity-50" : ""}">
        <span class="flex size-9 shrink-0 items-center justify-center rounded-full bg-slate-200 text-sm font-semibold dark:bg-slate-700">${esc(u.full_name.slice(0, 1))}</span>
        <span class="min-w-0 flex-1"><span class="block truncate font-medium">${esc(u.full_name)}</span><span class="block truncate text-xs text-slate-500">${esc(u.email)}</span></span>
        <span class="flex shrink-0 flex-wrap justify-end gap-1.5">${logosIn(u.id, g.id)}</span>
        ${x}
      </div>`;
    }

    // 模块列：这个 Business ＋ Company 能用的模块（拖到人名上 = 开权限；人也可以拖到模块上）
    function moduleBar(g, c) {
      const list = modulesForLine(ctx, g.id, c ? c.id : "");
      if (!list.length) return `<div class="mb-3 rounded-xl border border-dashed border-slate-200 px-3 py-3 text-center text-xs text-slate-400 dark:border-slate-700">${esc(tu2("noModulesHere"))}</div>`;
      const tile = (mod) => {
        const can = canGrantMod(g.id, mod.id);
        return `<div data-mod="${mod.id}" ${can ? `data-drop-mod="${mod.id}"` : ""} title="${esc(mod.name)}" class="gw-mod flex w-28 min-w-[6rem] shrink-0 ${can ? "cursor-grab active:cursor-grabbing" : "opacity-60"} flex-col items-center gap-1.5 rounded-xl p-2 text-center select-none hover:bg-white/70 dark:hover:bg-white/5">
          ${modLogo(mod, "size-10")}${tileName(mod.name, "text-slate-700 dark:text-slate-200")}
        </div>`;
      };
      return `<div class="mb-3 rounded-xl border border-slate-200/80 bg-slate-50/70 p-2 dark:border-slate-700 dark:bg-slate-800/40">
        <div id="ug-mods" class="flex flex-wrap gap-1">${list.map(tile).join("")}</div>
        ${list.some((mod) => canGrantMod(g.id, mod.id)) ? `<p class="mt-1 px-1 text-[11px] text-slate-400">${esc(tu2("dragHint"))}</p>` : ""}
      </div>`;
    }

    function draw() {
      sortables.forEach((x) => x.destroy());
      sortables = [];
      const unplaced = users.filter((u) => u.status === "active" && u.role !== "super_admin" && groupsOf(u.id).length === 0);
      const pending = unplaced.filter((u) => !hidden.has(u.id));
      const hiddenUsers = users.filter((u) => hidden.has(u.id));
      const q = query.trim().toLowerCase();
      const hit = (u) => !q || (u.full_name + " " + u.email).toLowerCase().includes(q);
      const leftList = (showHidden ? hiddenUsers : pending).filter(hit);
      const g = groups.find((x) => x.id === state.gid);
      const comps = g ? companiesOf(g.id) : [];
      const c = comps.find((x) => x.id === state.cid) || null;
      const members = g ? users.filter((u) => memberSet.has(g.id + ":" + u.id)).sort((a, b) => a.full_name.localeCompare(b.full_name)) : [];
      const shown = members.filter((u) => (c ? cosOf(g.id, u.id).has(c.id) : cosOf(g.id, u.id).size === 0));
      shared.pendingN = members.filter((u) => cosOf(g.id, u.id).size === 0).length;

      host.innerHTML = `<div class="flex flex-col gap-4 lg:flex-row">
        ${
          canAdd
            ? `<aside class="w-full shrink-0 self-start lg:sticky lg:top-20 lg:w-64">
                <div class="${cls.card} p-3">
                  <p class="mb-2 text-xs font-bold tracking-wider ${showHidden ? "text-slate-500" : "text-amber-600"} uppercase">${esc(tu2(showHidden ? "hiddenList" : "pending"))}</p>
                  <input id="ug-q" type="search" value="${esc(query)}" placeholder="${esc(t("admin.users.search"))}" class="${cls.input} mb-2 h-9">
                  <div id="ug-left" data-mode="${showHidden ? "hidden" : "pending"}" class="max-h-[45vh] space-y-1.5 overflow-y-auto">${
                    leftList.length ? leftList.map((u) => chip(u, showHidden)).join("") : `<p class="py-6 text-center text-sm text-slate-400">${esc(tu2(showHidden ? "noHidden" : "pendingEmpty"))}</p>`
                  }</div>
                  ${
                    showHidden
                      ? `<button type="button" data-hidden-toggle class="mt-2 inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">${icon("arrow-left", "size-3.5")}${esc(tu2("backToPending"))}</button>`
                      : hiddenUsers.length || isSuper
                        ? `<button type="button" data-hidden-toggle class="mt-2 inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">${icon("eye-off", "size-3.5")}${esc(tu2("hiddenList"))} (${hiddenUsers.length})</button>`
                        : ""
                  }
                </div>
              </aside>`
            : ""
        }
        <section class="${cls.card} min-w-0 flex-1 p-3">
          ${
            g
              ? `${moduleBar(g, c)}
                 <div id="ug-list" ${canAddTo(g.id) ? `data-drop="${g.id}"` : ""} data-company="${c ? c.id : ""}" class="${canAddTo(g.id) ? "gw-drop" : ""} max-h-[70vh] min-h-24 space-y-1.5 overflow-y-auto rounded-xl border-2 border-dashed border-slate-200/80 p-1.5 dark:border-slate-700">${
                   shown.map((u) => row(u, g, c)).join("") || `<p class="py-6 text-center text-sm text-slate-400">${esc(tu2("dropHere"))}</p>`
                 }</div>
                 ${comps.length ? "" : `<p class="mt-2 text-xs text-slate-400">${esc(tu2("noCompanies"))} <a href="#company" class="underline">${esc(t("admin.tabs.company"))}</a></p>`}`
              : `<div class="${cls.empty}">${esc(tu2("noBusiness"))} <a href="#business" class="font-medium underline">${esc(t("admin.sections.master"))} → ${esc(t("admin.tabs.business"))}</a></div>`
          }
        </section>
      </div>`;
      refreshIcons();

      // 放开时指标下面是什么（原生拖拉和触控的 fallback 都适用）
      const dropTarget = (evt, sel) => {
        const oe = evt.originalEvent || {};
        const pt = oe.changedTouches && oe.changedTouches[0] ? oe.changedTouches[0] : oe;
        if (typeof pt.clientX !== "number") return null;
        const el = document.elementFromPoint(pt.clientX, pt.clientY);
        return el ? el.closest(sel) : null;
      };
      const dragOpts = { sort: false, delay: 200, delayOnTouchOnly: true, animation: 150 };
      // 模块 → 人名：开权限
      const modsEl = $("#ug-mods");
      if (modsEl && g)
        sortables.push(
          window.Sortable.create(modsEl, {
            ...dragOpts,
            group: { name: "ugmod", pull: "clone", put: false },
            draggable: "[data-drop-mod]",
            onEnd: (evt) => {
              const target = dropTarget(evt, "[data-drop-user]");
              if (target) grant(target.dataset.dropUser, evt.item.dataset.mod);
            },
          }),
        );
      // 人名 → 模块：也是开权限；左边待分配的人拖进名单 = 加进这个 Business 和选的 Company（选「待分配」就只加进 Business）
      const el = $("#ug-list");
      if (el && g)
        sortables.push(
          window.Sortable.create(el, {
            ...dragOpts,
            group: { name: "ug", pull: "clone", put: (to, from) => from.el.id === "ug-left" && !!el.dataset.drop },
            draggable: "[data-user]",
            filter: ".no-drag",
            preventOnFilter: false,
            onAdd: (evt) => {
              const uid = evt.item.dataset.user;
              evt.item.remove();
              place(el.dataset.drop, el.dataset.company || null, uid, null);
            },
            onEnd: (evt) => {
              if (evt.from !== el) return;
              if (evt.clone && evt.clone.parentNode && evt.clone !== evt.item) evt.clone.remove();
              const target = dropTarget(evt, "[data-drop-mod]");
              if (target) grant(evt.item.dataset.user, target.dataset.dropMod);
            },
          }),
        );
      if (!canAdd) return;
      if ($("#ug-left") && !showHidden)
        sortables.push(window.Sortable.create($("#ug-left"), { ...dragOpts, group: { name: "ug", pull: "clone", put: false }, filter: ".no-drag" }));
      $("#ug-q")?.addEventListener("input", (e) => {
        query = shared.q = e.target.value;
        const pos = e.target.selectionStart;
        draw();
        const input = $("#ug-q");
        input.focus();
        input.setSelectionRange(pos, pos);
      });
    }

    // 开某个人某个模块的 Access（拖拉用）：已经有就提示；不能开就说原因
    async function grant(uid, mid) {
      const u = userById.get(uid), mod = modById.get(mid), gid = state.gid;
      if (!u || !mod) return;
      if (ctx.rows.has(uid + ":" + mid)) return toast(tu2("alreadyHasAccess", { module: mod.name }));
      if (!ctx.canGrant(u, gid, mid)) return setMsg(t("admin.access." + (u.id === me.id || u.role === "super_admin" ? "lockedReason" : "noGrantReason")));
      if (!(await saveAccess(ctx, uid, mid, true, false))) return draw();
      toast(tu2("accessGiven", { name: u.full_name, module: mod.name }));
      draw();
    }

    // 隐藏 / 放回待分配：整份名单存在 gw_settings.hidden_users
    async function saveHidden() {
      const { error } = await sb.from("gw_settings").upsert({ key: "hidden_users", value: { ids: [...hidden] }, updated_at: new Date().toISOString(), updated_by: me.id });
      if (error) setMsg(tg("saveFailed"));
      return !error;
    }
    // 从 Business 拿掉：先删他在这个 Business 的 Company，再删 Business 成员
    async function removeFromBiz(gid, uid) {
      const key = gid + ":" + uid;
      if (cosOf(gid, uid).size) {
        const { error } = await sb.from("gw_member_companies").delete().eq("group_id", gid).eq("user_id", uid);
        if (error) return setMsg(tg("saveFailed"));
      }
      const { error } = await sb.from("gw_group_members").delete().eq("group_id", gid).eq("user_id", uid);
      if (error) return setMsg(tg("saveFailed"));
      memberSet.delete(key);
      coMap.delete(key);
      draw();
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

    host.onclick = async (e) => {
      const b = e.target.closest("button, [data-user]");
      if (!b) return;
      const d = b.dataset;
      if (d.info) return companyInfo(d.info, d.from || null);
      if (d.outBiz) {
        const [gid, uid] = d.outBiz.split(":");
        return removeFromBiz(gid, uid);
      }
      if ("hiddenToggle" in d) return ((showHidden = !showHidden), draw());
      if (d.hide || d.unhide) {
        b.disabled = true;
        d.hide ? hidden.add(d.hide) : hidden.delete(d.unhide);
        if (!(await saveHidden())) d.hide ? hidden.delete(d.hide) : hidden.add(d.unhide);
        return draw();
      }
      // 左边名单点名字：选 Business / Company（手机不方便拖拉时用）；Business 里点名字：看他的资料、所属 Company 和模块权限
      if (d.user && !e.target.closest(".no-drag")) return b.closest("#ug-left") ? (canAdd && !showHidden ? pick(d.user) : userWindow(d.user, () => shared.reload())) : userWindow(d.user, () => shared.reload());
    };
    shared.refresh = draw;
    draw();
  }

  /* User & Group Manage 只有一个画面：
       上面：Business → Company 横条（People / Modules 用；All users 不受它影响）
       中间：三个切换 People（By Group：模块列 + 名单 + 待分配）/ Modules（模块手风琴）/ All users（全部用户）
       记住上次看的是哪一个（gw_ug_view）；#groups / #access / #users 深连结各自打开对应的切换 */
  const VIEW_OF_HASH = { groups: "people", access: "modules", users: "all" };
  async function usersScreen(initialView) {
    const seq = routeSeq;
    const [allGroups, companies, links] = await Promise.all([
      sb.from("gw_groups").select("id, name").order("sort_order").order("name"),
      sb.from("gw_companies").select("id, code, name, short_name").eq("is_active", true).order("sort_order").order("name"),
      sb.from("gw_business_companies").select("group_id, company_id"),
    ]).then((r) => r.map((x) => x.data || []));
    if (stale(seq)) return;
    // 角色只看到自己管的 Business
    const groups = allGroups.filter((g) => isSuper || (me.businessIds || []).includes(g.id));
    const companiesOf = (gid) => companies.filter((c) => links.some((l) => l.group_id === gid && l.company_id === c.id));
    const views = [
      ...(canGroupsPage ? [["people", "groups", peopleView]] : []),
      ...(canAccessPage ? [["modules", "access", modulesView]] : []),
      ...(canUsersPage ? [["all", "users", allUsersView]] : []),
    ];
    if (!views.length) return (view.innerHTML = empty(t("admin.access.empty")));
    let cur = initialView || ugRecall("gw_ug_view");
    if (!views.some(([k]) => k === cur)) cur = views[0][0];
    const shared = { state: ugState(groups, companiesOf, true), groups, companiesOf, q: "", pendingN: 0, refresh: () => {}, reload: () => show(cur) };

    view.innerHTML = `<div class="space-y-3">
      <div class="${cls.card} p-3">
        <div id="ug-bar"></div>
        <div class="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
          <div id="ug-views" class="inline-flex gap-1 rounded-xl bg-slate-200/70 p-1 dark:bg-slate-800"></div>
        </div>
      </div>
      <div id="ug-host"></div>
    </div>`;
    const host = $("#ug-host");
    function paintBar() {
      const comps = shared.state.gid ? companiesOf(shared.state.gid) : [];
      // People：Company 下拉多一个「待分配」；Modules：没有；All users：横条不影响名单（淡掉）
      if (cur === "modules" && shared.state.cid === "" && comps.length) shared.state.cid = comps[0].id;
      $("#ug-bar").innerHTML = groups.length
        ? `<div class="${cur === "all" ? "pointer-events-none opacity-40" : ""}" ${cur === "all" ? 'aria-disabled="true"' : ""}>${ugBar({ groups, gid: shared.state.gid, comps, cid: shared.state.cid, pendingLabel: cur === "people" ? t("admin.userGroups.pendingToggle", { count: shared.pendingN }) : null })}</div>`
        : `<p class="pb-3 text-sm text-slate-400">${esc(t("admin.userGroups.noBusiness"))} <a href="#business" class="font-medium underline">${esc(t("admin.sections.master"))} → ${esc(t("admin.tabs.business"))}</a></p>`;
      $("#ug-views").innerHTML = views
        .map(([k, tab]) => `<button type="button" data-view="${k}" aria-pressed="${k === cur}" class="rounded-lg px-3.5 py-1.5 text-sm font-medium whitespace-nowrap ${
          k === cur ? "bg-white text-slate-900 shadow-sm dark:bg-slate-950 dark:text-white" : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
        }">${esc(t("admin.tabs." + tab))}</button>`)
        .join("");
      refreshIcons();
    }
    async function show(k) {
      cur = k;
      ugRemember("gw_ug_view", k);
      host.onclick = host.onchange = host.oninput = null;
      host.innerHTML = GW.spinner();
      paintBar();
      await views.find(([x]) => x === k)[2](host, shared);
      if (!stale(seq)) paintBar(); // pendingN 现在知道了
    }
    const onBar = (e) => {
      if (e.target.closest("#ug-host")) return;
      const b = e.target.closest("[data-view]");
      if (b) return show(b.dataset.view);
      if (ugBarEvent(e, shared.state, companiesOf, cur === "people")) {
        paintBar();
        shared.refresh();
      }
    };
    view.onclick = onBar;
    view.onchange = onBar;
    await show(cur);
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
  const HANDLERS = { users: usersScreen, roles: rolesTab, business: businessTab, company: companyTab, sectors: sectorsTab, modules: modulesTab, connector: connectorTab, audit: auditTab };
  /* 上面的大按钮（User & Group Manage / Master Manage / Audit Log），永远一排：
       还没点任何一个 → 三个一样大、置中，下面什么都不显示
       点了 → 点的那个放中间、放大；其他的缩成小药丸排在左边 */
  function paintSections(activeKey) {
    const box = $("#sections");
    if (SECTIONS.length < 2) return (box.innerHTML = "");
    const base = "flex items-center justify-center gap-1.5 whitespace-nowrap font-semibold transition-all duration-300 ease-out";
    const big = `${base} rounded-2xl bg-slate-900 px-4 py-3 text-sm text-white shadow-md sm:px-7 sm:py-3.5 sm:text-base dark:bg-white dark:text-slate-900`;
    const pill = `${base} rounded-full border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800`;
    const mid = `${base} rounded-2xl border border-slate-200 bg-white px-3 py-3 text-xs text-slate-700 hover:bg-slate-50 sm:px-5 sm:text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800`;
    // 小药丸在手机上只显示图示（文字放不下）
    const link = ([k, ic, tabs], cls) => `<a data-sec="${k}" href="#${tabs[0]}" aria-current="${k === activeKey ? "page" : "false"}" title="${esc(t("admin.sections." + k))}" class="${cls}">${icon(ic, cls === pill ? "size-4 shrink-0" : "size-5 shrink-0")}<span class="${cls === pill ? "hidden sm:inline" : ""}">${esc(t("admin.sections." + k))}</span></a>`;
    if (!activeKey) {
      box.innerHTML = `<div class="flex flex-nowrap items-center justify-center gap-2">${SECTIONS.map((x) => link(x, mid)).join("")}</div>`;
    } else {
      const act = SECTIONS.find(([k]) => k === activeKey);
      // 手机：药丸靠左、大按钮占剩下的宽；sm 以上：三栏，大按钮正中间
      box.innerHTML = `<div class="grid grid-cols-[auto_1fr] items-center gap-2 sm:grid-cols-[1fr_auto_1fr]">
        <div class="flex shrink-0 flex-nowrap items-center justify-start gap-1.5">${SECTIONS.filter((x) => x !== act).map((x) => link(x, pill)).join("")}</div>
        ${link(act, big + " min-w-0 sm:justify-self-center")}
        <div class="hidden sm:block"></div>
      </div>`;
    }
    refreshIcons();
  }
  let activeSection = null;
  async function route() {
    const hash = location.hash.slice(1);
    routeSeq++;
    view.onclick = null;
    view.onsubmit = null;
    view.onchange = null;
    view.oninput = null;
    setMsg("");
    // 还没选区块：只显示上面的按钮
    if (!hash) {
      activeSection = null;
      paintSections(null);
      $("#panel").classList.add("hidden");
      view.innerHTML = "";
      return;
    }
    const name0 = hash.split("=")[0];
    // #groups / #access 是 Users 画面里的切换
    const name = VIEW_OF_HASH[name0] ? "users" : name0;
    const active = HANDLERS[name] && TABS.includes(name) ? name : TABS[0];
    const section = SECTIONS.find(([, , tabs]) => tabs.includes(active));
    activeSection = section[0];
    paintSections(activeSection);
    $("#panel").classList.remove("hidden");
    $("#tabs").parentElement.classList.toggle("hidden", section[2].length < 2);
    $("#tabs").innerHTML = section[2]
      .map(
        (k) => `<a href="#${k}" class="rounded-lg px-3.5 py-1.5 text-sm font-medium whitespace-nowrap ${
          k === active ? "bg-white text-slate-900 shadow-sm dark:bg-slate-950 dark:text-white" : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
        }">${esc(t("admin.tabs." + k))}</a>`,
      )
      .join("");
    view.innerHTML = GW.spinner();
    await HANDLERS[active](active === "users" ? VIEW_OF_HASH[name0] : undefined);
  }
  window.addEventListener("hashchange", route);
  route();
})();
