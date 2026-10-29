/* ================================================================
   MJM Connect — 主画面（像 iPhone 的主画面）
   App 图标、小工具（widget）、文件夹放在同一个格子里，拖拉可排版（SortableJS，手机长按）。
   右下角浮动按钮：Add Widget、Add Apps（把 App 拖到想放的位置）、New Folder、Edit Home Screen。
   位置：App 存 gw_user_layout、文件夹存 gw_user_folders、小工具存 gw_user_widgets，三者共用同一个顺序。
   权限关掉的 App 不显示，但位置记录保留。
   ================================================================ */
window.GWHome = (function () {
  const { sb, t, esc, $, $$, icon, moduleIcon, cls, btn, modal, confirmDialog, toast, openModule, refreshIcons } = GW;

  // App 图标底色（依模块代码固定挑一个）
  const TILE = [
    "from-sky-400 to-blue-600",
    "from-emerald-400 to-green-600",
    "from-teal-400 to-cyan-600",
    "from-indigo-400 to-violet-600",
    "from-amber-400 to-orange-500",
    "from-rose-400 to-pink-600",
    "from-slate-500 to-slate-700",
    "from-lime-400 to-emerald-600",
  ];
  const tileColor = (code) => TILE[[...code].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % TILE.length];

  // 小工具种类与可选大小
  const WIDGETS = {
    greeting: { sizes: ["medium"], icon: "sun" },
    clock: { sizes: ["small", "medium"], icon: "clock" },
    search: { sizes: ["medium"], icon: "search" },
    recent: { sizes: ["small", "medium"], icon: "history" },
    announcements: { sizes: ["medium", "large"], icon: "megaphone" },
    calendar: { sizes: ["small", "medium"], icon: "calendar" },
    notes: { sizes: ["small", "medium", "large"], icon: "sticky-note" },
    // 管理入口已改为右上角齿轮；旧的管理小工具仍照常显示，但不再提供新增
    admin: { sizes: ["medium"], icon: "shield-check", hidden: true },
  };
  // 格子大小：App 1×1；小 2×2；中 4×2；大 4×4
  const SPAN = { small: "col-span-2 row-span-2", medium: "col-span-4 row-span-2", large: "col-span-4 row-span-4" };

  function render(root, data, opts) {
    const readOnly = !!(opts && opts.readOnly);
    const profile = (opts && opts.profile) || data.profile;
    const isSuper = profile.role === "super_admin";
    const isAdmin = isSuper || profile.role === "admin";
    const widgetsEnabled = !!(opts && Array.isArray(opts.widgets));
    const uninitialized = readOnly && !data.profile.layout_initialized;

    const modules = new Map(data.modules.map((m) => [m.id, m]));
    let folders = data.folders.map((f) => ({ ...f }));
    let widgets = widgetsEnabled ? opts.widgets.map((w) => ({ ...w })) : [];
    // App 位置（只记录目前有权限的）
    let layout = new Map(data.layout.map((l) => [l.module_id, { folder_id: l.folder_id, sort_order: l.sort_order }]));
    if (uninitialized) data.modules.forEach((m, i) => layout.set(m.id, { folder_id: null, sort_order: i + 1 }));

    let editing = false;
    let sheet = null; // "apps" | "widgets" | null
    let fabOpen = false;
    let lastDragEnd = 0;
    let sortables = [];
    let clockTimer = null;

    // ------------------------------------------------------------ 资料
    function rootItems() {
      const items = [];
      layout.forEach((l, id) => modules.has(id) && !l.folder_id && items.push({ kind: "app", id, order: l.sort_order }));
      folders.forEach((f) => items.push({ kind: "folder", id: f.id, order: f.sort_order }));
      widgets.forEach((w) => items.push({ kind: "widget", id: w.id, order: w.sort_order }));
      return items.sort((a, b) => a.order - b.order);
    }
    const folderApps = (fid) =>
      [...layout.entries()]
        .filter(([id, l]) => l.folder_id === fid && modules.has(id))
        .sort((a, b) => a[1].sort_order - b[1].sort_order)
        .map(([id]) => id);
    const maxOrder = () => Math.max(0, ...[...layout.values()].map((l) => l.sort_order), ...folders.map((f) => f.sort_order), ...widgets.map((w) => w.sort_order));

    async function saveApps(items) {
      if (readOnly || !items.length) return;
      const { error } = await sb.rpc("gw_save_layout", { p_items: items.map((i) => ({ ...i, card_size: "large" })) });
      if (error) toast(t("home.saveFailed"));
    }

    // 拖拉之后：依画面顺序重新编号并保存
    async function saveOrder() {
      const els = $$("#gw-grid > [data-kind]", root);
      const apps = [];
      const folderUpdates = [];
      const widgetRows = [];
      els.forEach((el, i) => {
        const order = i + 1;
        const { kind, id } = el.dataset;
        if (kind === "app") {
          layout.set(id, { folder_id: null, sort_order: order });
          apps.push({ module_id: id, folder_id: null, sort_order: order });
        } else if (kind === "folder") {
          const f = folders.find((x) => x.id === id);
          if (f && f.sort_order !== order) folderUpdates.push(sb.from("gw_user_folders").update({ sort_order: order }).eq("id", id));
          if (f) f.sort_order = order;
        } else if (kind === "widget") {
          const w = widgets.find((x) => x.id === id);
          if (w) {
            w.sort_order = order;
            widgetRows.push(w);
          }
        }
      });
      await Promise.all([
        saveApps(apps),
        ...folderUpdates,
        widgetRows.length ? sb.from("gw_user_widgets").upsert(widgetRows.map(({ id, user_id, widget_type, size, sort_order, config }) => ({ id, user_id, widget_type, size, sort_order, config }))) : null,
      ]);
    }

    async function addApp(id, beforeIndex) {
      if (layout.has(id) && modules.has(id)) return;
      layout.set(id, { folder_id: null, sort_order: maxOrder() + 1 });
      draw();
      if (beforeIndex != null) {
        // 拖进来的：移到放下的位置再存整体顺序
        const grid = $("#gw-grid", root);
        const el = grid.querySelector(`[data-kind="app"][data-id="${id}"]`);
        const ref = grid.children[beforeIndex];
        if (el && ref && ref !== el) grid.insertBefore(el, ref);
        await saveOrder();
      } else {
        await saveApps([{ module_id: id, folder_id: null, sort_order: layout.get(id).sort_order }]);
      }
      sb.rpc("gw_mark_seen", { p_modules: [id] });
      toast(t("home.added"));
      draw();
    }

    async function removeApp(id) {
      layout.delete(id);
      draw();
      const { error } = await sb.from("gw_user_layout").delete().eq("module_id", id).eq("user_id", data.profile.id);
      if (error) toast(t("home.saveFailed"));
    }

    async function addWidget(type, size) {
      if (!widgetsEnabled) return toast(t("widgets.unavailable"));
      const { data: row, error } = await sb
        .from("gw_user_widgets")
        .insert({ user_id: data.profile.id, widget_type: type, size, sort_order: maxOrder() + 1, config: {} })
        .select()
        .single();
      if (error) return toast(t("home.saveFailed"));
      widgets.push(row);
      sheet = null;
      draw();
      toast(t("widgets.added"));
      setTimeout(() => {
        const el = root.querySelector(`[data-kind="widget"][data-id="${row.id}"]`);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 50);
    }

    async function removeWidget(id) {
      widgets = widgets.filter((w) => w.id !== id);
      draw();
      await sb.from("gw_user_widgets").delete().eq("id", id);
    }

    async function resizeWidget(id) {
      const w = widgets.find((x) => x.id === id);
      const sizes = WIDGETS[w.widget_type].sizes;
      w.size = sizes[(sizes.indexOf(w.size) + 1) % sizes.length];
      draw();
      await sb.from("gw_user_widgets").update({ size: w.size }).eq("id", id);
    }

    // ------------------------------------------------------------ App / 文件夹 / 小工具外观
    const newDot = (m) => (m.is_new ? `<span class="absolute -top-1 -right-1 size-3 rounded-full border-2 border-white bg-rose-500 dark:border-slate-900"></span>` : "");
    const badge = (attr, ic, label, pos) =>
      `<button type="button" ${attr} aria-label="${esc(label)}" class="no-drag absolute ${pos} z-10 flex size-6 items-center justify-center rounded-full bg-slate-700/90 text-white shadow ring-2 ring-white dark:ring-slate-900">${icon(ic, "size-3.5")}</button>`;

    function appIcon(m, size) {
      return `<span class="relative flex ${size || "size-14 sm:size-16"} items-center justify-center rounded-[26%] bg-gradient-to-br ${tileColor(m.code)} text-white shadow-md shadow-slate-900/10">
        ${moduleIcon(m.icon, "size-7 sm:size-8")}${newDot(m)}
      </span>`;
    }

    function appTile(id) {
      const m = modules.get(id);
      return `<div data-kind="app" data-id="${id}" class="gw-item relative flex flex-col items-center gap-1.5 pt-1">
        <button type="button" data-open="${id}" class="flex flex-col items-center gap-1.5" title="${esc(m.description || m.name)}">
          ${appIcon(m)}
          <span class="w-20 truncate text-center text-xs font-medium text-slate-700 dark:text-slate-200">${esc(m.name)}</span>
        </button>
        ${editing ? badge(`data-remove-app="${id}"`, "minus", t("home.removeFromHome"), "top-0 left-1/2 -translate-x-[2.4rem]") + badge(`data-app-menu="${id}"`, "ellipsis", t("home.cardMenu"), "top-0 left-1/2 translate-x-[1rem]") : ""}
      </div>`;
    }

    function folderTile(f) {
      const ids = folderApps(f.id);
      const minis = ids.slice(0, 9).map((id) => `<span class="aspect-square rounded-[28%] bg-gradient-to-br ${tileColor(modules.get(id).code)}"></span>`).join("");
      return `<div data-kind="folder" data-id="${f.id}" class="gw-item relative flex flex-col items-center gap-1.5 pt-1">
        <button type="button" data-folder="${f.id}" class="flex flex-col items-center gap-1.5">
          <span class="grid size-14 grid-cols-3 grid-rows-3 content-start gap-1 rounded-[26%] border border-white/60 bg-white/55 p-2 shadow-md shadow-slate-900/10 backdrop-blur sm:size-16 dark:border-white/10 dark:bg-white/10">${minis}</span>
          <span class="w-20 truncate text-center text-xs font-medium text-slate-700 dark:text-slate-200">${esc(f.name)}</span>
        </button>
        ${editing ? badge(`data-remove-folder="${f.id}"`, "minus", t("home.deleteFolder"), "top-0 left-1/2 -translate-x-[2.4rem]") : ""}
      </div>`;
    }

    const glass =
      "relative h-full overflow-hidden rounded-3xl border border-white/70 bg-white/75 p-4 shadow-lg shadow-slate-900/5 backdrop-blur-xl dark:border-white/10 dark:bg-slate-900/70";
    const wTitle = (ic, text) => `<div class="mb-2 flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">${icon(ic, "size-3.5")}${esc(text)}</div>`;

    function widgetBody(w) {
      const now = new Date();
      const tz = GW_CONFIG.timeZone;
      const fmt = (o) => new Intl.DateTimeFormat(GW.LOCALE, { timeZone: tz, ...o }).format(now);
      switch (w.widget_type) {
        case "greeting": {
          const h = Number(fmt({ hour: "numeric", hour12: false }));
          const key = h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
          const count = [...layout.keys()].filter((id) => modules.has(id)).length;
          return `<div class="flex h-full flex-col justify-between">
            <div>
              <div class="text-sm text-slate-500">${esc(fmt({ weekday: "long", day: "numeric", month: "long" }))}</div>
              <div class="mt-1 text-xl font-bold sm:text-2xl">${esc(t("widgets.greeting." + key, { name: profile.full_name }))}</div>
            </div>
            <div class="text-sm text-slate-500">${esc(t("widgets.appsOnHome", { count }))}</div>
          </div>`;
        }
        case "clock":
          return `<div class="flex h-full flex-col justify-center ${w.size === "small" ? "items-center text-center" : ""}">
            <div data-clock class="font-bold tabular-nums ${w.size === "small" ? "text-3xl" : "text-5xl"}">${esc(fmt({ hour: "2-digit", minute: "2-digit", hour12: false }))}</div>
            <div class="mt-1 text-sm text-slate-500">${esc(fmt({ weekday: "short", day: "numeric", month: "short" }))}</div>
          </div>`;
        case "search":
          return `${wTitle("search", t("widgets.types.search"))}
            <input data-widget-search type="search" placeholder="${esc(t("home.searchPlaceholder"))}" class="${cls.input} no-drag rounded-xl bg-white/80 dark:bg-slate-800/80">
            <div data-search-results class="mt-2 flex gap-3 overflow-x-auto"></div>`;
        case "recent": {
          const ids = data.recent.filter((id) => modules.has(id)).slice(0, w.size === "small" ? 4 : 5);
          return `${wTitle("history", t("home.recent"))}
            ${
              ids.length
                ? `<div class="${w.size === "small" ? "grid grid-cols-2 gap-2" : "flex gap-3 overflow-x-auto"}">${ids
                    .map((id) => `<button type="button" data-open="${id}" class="no-drag flex flex-col items-center gap-1">${appIcon(modules.get(id), "size-11")}${w.size === "small" ? "" : `<span class="w-14 truncate text-center text-[11px]">${esc(modules.get(id).name)}</span>`}</button>`)
                    .join("")}</div>`
                : `<p class="text-sm text-slate-400">${esc(t("widgets.noRecent"))}</p>`
            }`;
        }
        case "announcements":
          return `${wTitle("megaphone", t("widgets.types.announcements"))}
            ${
              data.announcements.length
                ? `<ul class="space-y-2 overflow-y-auto ${w.size === "large" ? "max-h-[85%]" : "max-h-[70%]"}">${data.announcements
                    .map((a) => `<li class="flex gap-2 text-sm">${icon(a.level === "warning" ? "triangle-alert" : "info", `mt-0.5 size-4 shrink-0 ${a.level === "warning" ? "text-amber-500" : "text-sky-500"}`)}<span class="whitespace-pre-line">${esc(a.message)}</span></li>`)
                    .join("")}</ul>`
                : `<p class="text-sm text-slate-400">${esc(t("widgets.noAnnouncements"))}</p>`
            }`;
        case "calendar": {
          const y = Number(fmt({ year: "numeric" }));
          const mo = Number(fmt({ month: "numeric" })) - 1;
          const today = Number(fmt({ day: "numeric" }));
          const first = new Date(Date.UTC(y, mo, 1)).getUTCDay();
          const days = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
          const names = [...Array(7)].map((_, i) => new Intl.DateTimeFormat(GW.LOCALE, { weekday: "narrow", timeZone: "UTC" }).format(new Date(Date.UTC(2023, 0, 1 + i))));
          const cells = [...Array(first).fill(""), ...[...Array(days)].map((_, i) => i + 1)];
          return `<div class="mb-1 text-sm font-semibold text-rose-500">${esc(fmt({ month: "long" }))}</div>
            <div class="grid grid-cols-7 gap-y-0.5 text-center ${w.size === "small" ? "text-[10px]" : "text-xs"}">
              ${names.map((n) => `<span class="font-semibold text-slate-400">${esc(n)}</span>`).join("")}
              ${cells.map((d) => `<span class="${d === today ? "mx-auto flex size-5 items-center justify-center rounded-full bg-rose-500 font-bold text-white" : ""}">${d}</span>`).join("")}
            </div>`;
        }
        case "notes":
          return `${wTitle("sticky-note", t("widgets.types.notes"))}
            <textarea data-note="${w.id}" ${readOnly ? "disabled" : ""} placeholder="${esc(t("widgets.notesPlaceholder"))}" class="no-drag h-[calc(100%-1.75rem)] w-full resize-none bg-transparent text-sm outline-none">${esc((w.config && w.config.text) || "")}</textarea>`;
        case "admin":
          return `${wTitle("shield-check", t("home.adminSection"))}
            <div class="grid content-start gap-2 ${isSuper ? "grid-cols-2" : "grid-cols-1"}">
              ${isAdmin ? `<a href="admin.html#users" class="no-drag flex items-center gap-2 rounded-2xl bg-sky-50 px-3 py-4 text-sky-700 hover:bg-sky-100 dark:bg-sky-900/30 dark:text-sky-200">${icon("user-cog", "size-6 shrink-0")}<span class="text-sm font-semibold">${esc(t("home.userAccess"))}</span></a>` : `<p class="text-sm text-slate-400">${esc(t("widgets.adminOnly"))}</p>`}
              ${isSuper ? `<a href="admin.html#modules" class="no-drag flex items-center gap-2 rounded-2xl bg-amber-50 px-3 py-4 text-amber-700 hover:bg-amber-100 dark:bg-amber-900/30 dark:text-amber-200">${icon("crown", "size-6 shrink-0")}<span class="text-sm font-semibold">${esc(t("home.superAdmin"))}</span></a>` : ""}
            </div>`;
      }
      return "";
    }

    function widgetTile(w) {
      return `<div data-kind="widget" data-id="${w.id}" class="gw-item relative ${SPAN[w.size]}">
        <div class="${glass}">${widgetBody(w)}</div>
        ${editing ? badge(`data-remove-widget="${w.id}"`, "minus", t("widgets.remove"), "-top-2 -left-2") : ""}
        ${editing && WIDGETS[w.widget_type].sizes.length > 1 ? badge(`data-resize="${w.id}"`, "scaling", t("widgets.resize"), "-right-2 -bottom-2") : ""}
      </div>`;
    }

    // ------------------------------------------------------------ 新增 App / 小工具 面板
    function appsSheet() {
      const onHome = new Set([...layout.keys()].filter((id) => modules.has(id)));
      return `<div class="mb-3 flex items-center justify-between"><h3 class="font-semibold">${esc(t("fab.addApps"))}</h3>${iconBtn("data-close-sheet", t("home.close"), "x")}</div>
        <p class="mb-3 text-xs text-slate-500">${esc(t("fab.addAppsHint"))}</p>
        <input data-sheet-search type="search" placeholder="${esc(t("home.searchPlaceholder"))}" class="${cls.input} mb-3">
        ${
          data.modules.length
            ? `<div class="gw-sheet-apps grid grid-cols-4 gap-x-2 gap-y-4">${data.modules
                .map((m) => {
                  const added = onHome.has(m.id);
                  return `<div data-lib="${m.id}" data-name="${esc((m.name + " " + m.code).toLowerCase())}" class="${added ? "gw-added opacity-50" : "cursor-grab"} relative flex flex-col items-center gap-1">
                    ${appIcon(m, "size-14")}
                    <span class="w-full truncate text-center text-[11px]">${esc(m.name)}</span>
                    ${added ? `<span class="absolute top-0 right-1 flex size-5 items-center justify-center rounded-full bg-emerald-500 text-white">${icon("check", "size-3")}</span>` : `<button type="button" data-add="${m.id}" aria-label="${esc(t("home.addToHome"))}" class="no-drag absolute top-0 right-1 flex size-5 items-center justify-center rounded-full bg-slate-700 text-white">${icon("plus", "size-3")}</button>`}
                  </div>`;
                })
                .join("")}</div>`
            : `<div class="${cls.empty}">${esc(t("home.noModules"))}</div>`
        }`;
    }

    function widgetsSheet() {
      const types = Object.entries(WIDGETS).filter(([, d]) => !d.hidden);
      return `<div class="mb-3 flex items-center justify-between"><h3 class="font-semibold">${esc(t("fab.addWidget"))}</h3>${iconBtn("data-close-sheet", t("home.close"), "x")}</div>
        <p class="mb-3 text-xs text-slate-500">${esc(t("fab.addWidgetHint"))}</p>
        <div class="space-y-2">${types
          .map(
            ([type, d]) => `<div class="flex items-center gap-3 rounded-2xl border border-slate-200 p-3 dark:border-slate-800">
              <span class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">${icon(d.icon, "size-5")}</span>
              <span class="min-w-0 flex-1">
                <span class="block text-sm font-semibold">${esc(t("widgets.types." + type))}</span>
                <span class="block text-xs text-slate-500">${esc(t("widgets.desc." + type))}</span>
              </span>
              <span class="flex gap-1">${d.sizes.map((s) => `<button type="button" data-add-widget="${type}" data-size="${s}" class="${btn("secondary", "sm")} px-2">${esc(t("widgets.sizes." + s))}</button>`).join("")}</span>
            </div>`,
          )
          .join("")}</div>`;
    }

    const iconBtn = (attr, label, name) =>
      `<button type="button" ${attr} aria-label="${esc(label)}" class="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">${icon(name)}</button>`;

    // ------------------------------------------------------------ 浮动按钮
    function fabHtml() {
      if (readOnly) return "";
      if (editing) {
        return `<button type="button" data-done class="fixed right-5 bottom-24 z-40 flex h-12 items-center gap-2 rounded-full bg-slate-900 px-5 font-semibold text-white shadow-xl sm:bottom-8 dark:bg-white dark:text-slate-900">${icon("check")} ${esc(t("fab.done"))}</button>`;
      }
      const items = [
        ["add-widget", "layout-dashboard", t("fab.addWidget")],
        ["add-apps", "layout-grid", t("fab.addApps")],
        ["new-folder", "folder-plus", t("fab.newFolder")],
        ["edit", "move", t("fab.edit")],
      ];
      return `<div class="fixed right-5 bottom-24 z-40 flex flex-col items-end gap-2 sm:bottom-8">
        ${
          fabOpen
            ? items
                .map(
                  ([k, ic, label]) => `<button type="button" data-fab="${k}" class="flex items-center gap-2 rounded-full border border-white/70 bg-white/90 py-2 pr-4 pl-3 text-sm font-medium shadow-lg backdrop-blur dark:border-white/10 dark:bg-slate-800/90">${icon(ic)} ${esc(label)}</button>`,
                )
                .join("")
            : ""
        }
        <button type="button" data-fab-toggle aria-label="${esc(t("fab.menu"))}" aria-expanded="${fabOpen}" class="flex size-14 items-center justify-center rounded-full bg-slate-900 text-white shadow-xl transition-transform dark:bg-white dark:text-slate-900 ${fabOpen ? "rotate-45" : ""}">${icon("plus", "size-6")}</button>
      </div>`;
    }

    // ------------------------------------------------------------ 整页
    const dismissed = (() => {
      try {
        return JSON.parse(localStorage.getItem("gw_dismissed_announcements") || "[]");
      } catch (e) {
        return [];
      }
    })();

    function draw() {
      sortables.forEach((s) => s.destroy());
      sortables = [];
      clearInterval(clockTimer);
      const items = rootItems();
      const announcements = data.announcements.filter((a) => !dismissed.includes(a.id));
      root.innerHTML = `
        ${announcements
          .map(
            (a) => `<div class="mb-4 flex items-start gap-2 rounded-2xl border px-3 py-2.5 text-sm backdrop-blur ${
              a.level === "warning" ? "border-amber-200 bg-amber-50/90 text-amber-900 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-200" : "border-white/70 bg-white/70 text-slate-700 dark:border-white/10 dark:bg-slate-900/60 dark:text-slate-200"
            }">${icon(a.level === "warning" ? "triangle-alert" : "megaphone", "mt-0.5 size-4 shrink-0")}<p class="flex-1 whitespace-pre-line">${esc(a.message)}</p>${readOnly ? "" : `<button data-dismiss="${a.id}" aria-label="${esc(t("home.dismiss"))}" class="rounded p-0.5 opacity-60 hover:opacity-100">${icon("x")}</button>`}</div>`,
          )
          .join("")}
        ${uninitialized ? `<div class="mb-4 rounded-2xl bg-white/70 px-3 py-2 text-sm text-slate-600 dark:bg-slate-900/60 dark:text-slate-300">${esc(t("home.previewUninitialized"))}</div>` : ""}
        ${editing ? `<p class="mb-3 text-center text-xs text-slate-500">${esc(t("fab.editHint"))}</p>` : ""}
        <div id="gw-grid" class="${editing ? "gw-editing" : ""} grid grid-flow-row-dense grid-cols-4 gap-x-2 gap-y-4 [grid-auto-rows:5.25rem] sm:grid-cols-6 sm:[grid-auto-rows:5.75rem] lg:grid-cols-8">
          ${items
            .map((i) => (i.kind === "app" ? appTile(i.id) : i.kind === "folder" ? folderTile(folders.find((f) => f.id === i.id)) : widgetTile(widgets.find((w) => w.id === i.id))))
            .join("")}
        </div>
        ${items.length === 0 ? `<div class="${cls.empty} mt-2 bg-white/60 dark:bg-slate-900/40">${esc(data.modules.length ? t("fab.emptyHome") : t("home.noModules"))}</div>` : ""}
        ${
          sheet
            ? `<aside class="gw-sheet fixed inset-x-0 bottom-0 z-50 max-h-[62vh] overflow-y-auto rounded-t-3xl border border-slate-200 bg-white p-4 shadow-2xl sm:inset-x-auto sm:top-20 sm:right-4 sm:bottom-4 sm:max-h-none sm:w-96 sm:rounded-3xl dark:border-slate-800 dark:bg-slate-900">${sheet === "apps" ? appsSheet() : widgetsSheet()}</aside>`
            : ""
        }
        ${fabHtml()}`;
      refreshIcons();
      if (!readOnly) setupSortable();
      if ($("[data-clock]", root)) {
        clockTimer = setInterval(() => {
          const now = new Intl.DateTimeFormat(GW.LOCALE, { timeZone: GW_CONFIG.timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
          $$("[data-clock]", root).forEach((el) => (el.textContent = now));
        }, 15000);
      }
    }

    // ------------------------------------------------------------ 拖拉
    function setupSortable() {
      const grid = $("#gw-grid", root);
      const start = () => document.body.classList.add("gw-dragging");
      const end = () => {
        document.body.classList.remove("gw-dragging");
        lastDragEnd = Date.now();
      };
      sortables.push(
        window.Sortable.create(grid, {
          group: { name: "gw", pull: false, put: true },
          animation: 180,
          delay: 250,
          delayOnTouchOnly: true,
          filter: ".no-drag",
          preventOnFilter: false,
          onStart: start,
          onAdd: (evt) => {
            // 从「Add Apps」面板拖进来
            const id = evt.item.dataset.lib;
            const index = evt.newIndex;
            evt.item.remove();
            end();
            if (id) addApp(id, index);
          },
          onEnd: () => {
            end();
            saveOrder();
          },
        }),
      );
      const lib = $(".gw-sheet-apps", root);
      if (lib) {
        sortables.push(
          window.Sortable.create(lib, {
            group: { name: "gw", pull: "clone", put: false },
            sort: false,
            animation: 150,
            delay: 200,
            delayOnTouchOnly: true,
            filter: ".no-drag, .gw-added",
            onStart: start,
            onEnd: end,
          }),
        );
      }
    }

    // ------------------------------------------------------------ App 选单 / 文件夹
    function appMenu(id) {
      const m = modules.get(id);
      const current = layout.get(id).folder_id || "";
      const dlg = modal(
        m.name,
        `<div class="space-y-4">
          <label class="block space-y-1.5"><span class="${cls.label}">${esc(t("home.moveTo"))}</span>
            <select data-move class="${cls.input}">
              <option value="">${esc(t("fab.homeScreen"))}</option>
              ${folders.map((f) => `<option value="${f.id}" ${current === f.id ? "selected" : ""}>${esc(f.name)}</option>`).join("")}
            </select>
          </label>
          <button data-remove class="${btn("ghost")} w-full text-red-600 dark:text-red-400">${icon("trash-2")} ${esc(t("home.removeFromHome"))}</button>
        </div>`,
      );
      $("[data-move]", dlg.el).addEventListener("change", async (e) => {
        const folderId = e.target.value || null;
        const order = folderId ? folderApps(folderId).length + 1 : maxOrder() + 1;
        layout.set(id, { folder_id: folderId, sort_order: order });
        dlg.close();
        draw();
        await saveApps([{ module_id: id, folder_id: folderId, sort_order: order }]);
      });
      $("[data-remove]", dlg.el).onclick = () => (dlg.close(), removeApp(id));
    }

    function openFolder(fid) {
      const f = folders.find((x) => x.id === fid);
      const ids = folderApps(fid);
      const dlg = modal(
        f.name,
        `<div class="space-y-4">
          ${
            ids.length
              ? `<div class="grid grid-cols-3 gap-4 sm:grid-cols-4">${ids
                  .map(
                    (id) => `<div class="relative flex flex-col items-center gap-1">
                      <button type="button" data-open="${id}" class="flex flex-col items-center gap-1">${appIcon(modules.get(id), "size-14")}<span class="w-20 truncate text-center text-xs">${esc(modules.get(id).name)}</span></button>
                      ${readOnly ? "" : `<button type="button" data-out="${id}" title="${esc(t("fab.moveOut"))}" aria-label="${esc(t("fab.moveOut"))}" class="absolute -top-1 right-2 flex size-6 items-center justify-center rounded-full bg-slate-700 text-white">${icon("arrow-up-right", "size-3.5")}</button>`}
                    </div>`,
                  )
                  .join("")}</div>`
              : `<p class="text-center text-sm text-slate-500">${esc(t("fab.emptyFolder"))}</p>`
          }
          ${readOnly ? "" : `<div class="flex justify-end gap-2 border-t border-slate-200 pt-3 dark:border-slate-800">
            <button data-rename class="${btn("ghost", "sm")}">${icon("pencil")} ${esc(t("home.editFolder"))}</button>
          </div>`}
        </div>`,
      );
      dlg.el.addEventListener("click", async (e) => {
        const b = e.target.closest("button");
        if (!b) return;
        if (b.dataset.open) return dlg.close(), open(b.dataset.open);
        if (b.dataset.out) {
          const id = b.dataset.out;
          const order = maxOrder() + 1;
          layout.set(id, { folder_id: null, sort_order: order });
          dlg.close();
          draw();
          await saveApps([{ module_id: id, folder_id: null, sort_order: order }]);
          return openFolder(fid);
        }
        if ("rename" in b.dataset) {
          dlg.close();
          folderDialog(f);
        }
      });
    }

    function folderDialog(folder) {
      const dlg = modal(
        folder ? t("home.editFolder") : t("fab.newFolder"),
        `<form class="space-y-4">
          <input name="name" maxlength="40" required value="${esc(folder ? folder.name : "")}" placeholder="${esc(t("home.folderName"))}" class="${cls.input}">
          <div class="flex justify-end gap-2">
            <button type="button" data-cancel class="${btn("secondary")}">${esc(t("home.cancel"))}</button>
            <button type="submit" class="${btn("primary")}">${esc(t("home.save"))}</button>
          </div>
        </form>`,
      );
      $("[data-cancel]", dlg.el).onclick = dlg.close;
      const input = $("[name=name]", dlg.el);
      input.focus();
      $("form", dlg.el).addEventListener("submit", async (e) => {
        e.preventDefault();
        const name = input.value.trim();
        if (!name) return;
        if (folder) {
          folder.name = name;
          await sb.from("gw_user_folders").update({ name }).eq("id", folder.id);
        } else {
          const { data: created, error } = await sb
            .from("gw_user_folders")
            .insert({ user_id: data.profile.id, name, color: "slate", sort_order: maxOrder() + 1 })
            .select("id, name, color, sort_order, collapsed")
            .single();
          if (error) return toast(t("home.saveFailed"));
          folders.push(created);
        }
        dlg.close();
        draw();
      });
    }

    async function deleteFolder(fid) {
      const f = folders.find((x) => x.id === fid);
      const ok = await confirmDialog(t("home.deleteFolderTitle"), t("home.deleteFolderBody", { name: f.name }), t("home.delete"), t("home.cancel"));
      if (!ok) return;
      // 文件夹里的 App 回到主画面最后面
      let order = maxOrder();
      const moved = folderApps(fid).map((id) => {
        layout.set(id, { folder_id: null, sort_order: ++order });
        return { module_id: id, folder_id: null, sort_order: order };
      });
      folders = folders.filter((x) => x.id !== fid);
      draw();
      const { error } = await sb.from("gw_user_folders").delete().eq("id", fid);
      if (error) return toast(t("home.saveFailed"));
      await saveApps(moved);
    }

    async function open(id) {
      if (readOnly || editing || Date.now() - lastDragEnd < 300) return;
      const m = modules.get(id);
      data.recent = [id, ...data.recent.filter((x) => x !== id)].slice(0, 5);
      if (m.is_new) m.is_new = false;
      const ok = await openModule(m);
      if (!ok) toast(t("home.openFailed"));
    }

    // ------------------------------------------------------------ 事件（委派）
    let noteTimer;
    root.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b || !root.contains(b)) {
        if (fabOpen && !e.target.closest("[data-fab-toggle]")) ((fabOpen = false), draw());
        return;
      }
      const d = b.dataset;
      if (d.open) return open(d.open);
      if (d.folder) return editing ? null : openFolder(d.folder);
      if (d.appMenu) return appMenu(d.appMenu);
      if (d.removeApp) return removeApp(d.removeApp);
      if (d.removeWidget) return removeWidget(d.removeWidget);
      if (d.removeFolder) return deleteFolder(d.removeFolder);
      if (d.resize) return resizeWidget(d.resize);
      if (d.dismiss) {
        dismissed.push(d.dismiss);
        try {
          localStorage.setItem("gw_dismissed_announcements", JSON.stringify(dismissed.slice(-50)));
        } catch (x) {
          /* localStorage 不可用时无法记住，忽略 */
        }
        return draw();
      }
      if ("fabToggle" in d) return ((fabOpen = !fabOpen), draw());
      if (d.fab) {
        fabOpen = false;
        if (d.fab === "add-widget") sheet = "widgets";
        else if (d.fab === "add-apps") sheet = "apps";
        else if (d.fab === "edit") ((editing = true), (sheet = null));
        else if (d.fab === "new-folder") return draw(), folderDialog(null);
        return draw();
      }
      if ("done" in d) return ((editing = false), draw());
      if ("closeSheet" in d) return ((sheet = null), draw());
      if (d.add) return addApp(d.add);
      if (d.addWidget) return addWidget(d.addWidget, d.size);
    });
    root.addEventListener("input", (e) => {
      const el = e.target;
      if (el.matches("[data-sheet-search]")) {
        const q = el.value.trim().toLowerCase();
        $$("[data-lib]", root).forEach((x) => x.classList.toggle("hidden", !!q && !x.dataset.name.includes(q)));
      } else if (el.matches("[data-widget-search]")) {
        const q = el.value.trim().toLowerCase();
        const box = el.parentElement.querySelector("[data-search-results]");
        const hits = q ? data.modules.filter((m) => [m.name, m.code, m.description].some((v) => v && v.toLowerCase().includes(q))).slice(0, 6) : [];
        box.innerHTML = q && !hits.length
          ? `<p class="text-sm text-slate-400">${esc(t("home.noResults"))}</p>`
          : hits.map((m) => `<button type="button" data-open="${m.id}" class="no-drag flex shrink-0 flex-col items-center gap-1">${appIcon(m, "size-11")}<span class="w-14 truncate text-center text-[11px]">${esc(m.name)}</span></button>`).join("");
        refreshIcons();
      } else if (el.matches("[data-note]")) {
        // 便条：停止输入一秒后自动保存
        const w = widgets.find((x) => x.id === el.dataset.note);
        w.config = { ...(w.config || {}), text: el.value.slice(0, 2000) };
        clearTimeout(noteTimer);
        noteTimer = setTimeout(() => sb.from("gw_user_widgets").update({ config: w.config }).eq("id", w.id), 1000);
      }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && (sheet || fabOpen || editing)) {
        sheet = null;
        fabOpen = false;
        editing = false;
        draw();
      }
    });

    draw();
  }

  return { render, WIDGETS };
})();
