/* ================================================================
   MJM Connect — 主画面（像 iPhone 的主画面）
   Notice Board 固定在最上面；下面是固定格子的棋盘，App 图标、小工具、文件夹可以拖到任何空格（手机长按），会自动对齐。
   右下角浮动按钮：Add Widget、Add Apps（把 App 拖到想放的位置）、New Folder、Edit Home Screen。
   位置：App 存 gw_user_layout、文件夹存 gw_user_folders、小工具存 gw_user_widgets，sort_order = 第几格（slot）。
   权限关掉的 App 不显示，但位置记录保留。
   ================================================================ */
window.GWHome = (function () {
  const { sb, t, esc, $, $$, icon, moduleIcon, cls, btn, modal, confirmDialog, toast, openModule, refreshIcons } = GW;

  /* App 图标底色。每个人可以自己选（记在 Notice Board 小工具的 config.icons，不用改数据库）：
       style：calm（预设，柔和低调）/ colorful（原本的多彩）/ 或固定一个颜色（全部图示同一个颜色）
       apps：个别 App 自己指定的颜色（优先） */
  const PALETTE = {
    slate: ["from-slate-400 to-slate-600", "#64748b"],
    blue: ["from-sky-400 to-blue-500", "#3b82f6"],
    teal: ["from-teal-400 to-teal-600", "#0d9488"],
    green: ["from-emerald-400 to-green-600", "#16a34a"],
    amber: ["from-amber-300 to-amber-500", "#f59e0b"],
    rose: ["from-rose-300 to-rose-500", "#f43f5e"],
    violet: ["from-violet-400 to-violet-600", "#7c3aed"],
    graphite: ["from-zinc-500 to-zinc-700", "#3f3f46"],
  };
  const COLORFUL = [
    "from-sky-400 to-blue-600",
    "from-emerald-400 to-green-600",
    "from-teal-400 to-cyan-600",
    "from-indigo-400 to-violet-600",
    "from-amber-400 to-orange-500",
    "from-rose-400 to-pink-600",
    "from-slate-500 to-slate-700",
    "from-lime-400 to-emerald-600",
  ];
  // 预设「calm」：低饱和的几个蓝灰色调
  const CALM = ["from-slate-400 to-slate-600", "from-sky-400 to-sky-600", "from-slate-500 to-slate-700", "from-teal-400 to-teal-600", "from-indigo-300 to-indigo-500"];
  let ICON = { style: "calm", apps: {} };
  const hashOf = (code) => [...String(code)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const tileColor = (code, id) => {
    const own = id && ICON.apps[id];
    if (own && PALETTE[own]) return PALETTE[own][0];
    if (PALETTE[ICON.style]) return PALETTE[ICON.style][0];
    const list = ICON.style === "colorful" ? COLORFUL : CALM;
    return list[hashOf(code) % list.length];
  };

  // 小工具种类与可选大小
  const WIDGETS = {
    greeting: { sizes: ["medium"], icon: "sun" },
    clock: { sizes: ["small", "medium"], icon: "clock" },
    search: { sizes: ["medium"], icon: "search" },
    recent: { sizes: ["small", "medium"], icon: "history" },
    // Notice Board：固定在最上面，只能调大小，不能移动、不能删除，也不能再加第二个
    announcements: { sizes: ["medium", "large"], icon: "megaphone", hidden: true, pinned: true },
    calendar: { sizes: ["small", "medium"], icon: "calendar" },
    weather: { sizes: ["small", "medium"], icon: "cloud-sun" },
    ai: { sizes: ["medium", "large"], icon: "bot" },
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
    const isAdmin = isSuper || !!profile.manages;
    const canPost = isSuper || !!profile.canPost;
    // 公告能不能改 / 删：super_admin 全部；角色按每个 Business 的功能
    const bizCan = (gid, f) => (profile.bizCan ? profile.bizCan(gid, f) : isSuper);
    const canEditNotice = (a) => !readOnly && (isSuper || (a.group_id && bizCan(a.group_id, "can_post_notice")));
    const canDeleteNotice = (a) => !readOnly && (isSuper || (a.group_id && bizCan(a.group_id, "can_delete_notice")));
    const widgetsEnabled = !!(opts && Array.isArray(opts.widgets));
    const uninitialized = readOnly && !data.profile.layout_initialized;

    const modules = new Map(data.modules.map((m) => [m.id, m]));
    // Notice Board 的表情反应：{ announcement_id, emoji, user_id, full_name }
    let reactions = ((opts && opts.reactions) || []).map((r) => ({ ...r }));
    const reactionsOn = !!(opts && Array.isArray(opts.reactions));
    const REACT = [
      ["like", "👍"],
      ["love", "❤️"],
      ["congrats", "🎉"],
    ];
    {
      const ic = ((opts && opts.widgets) || []).find((w) => w.widget_type === "announcements");
      const saved = ic && ic.config && ic.config.icons;
      ICON = { style: (saved && saved.style) || "calm", apps: { ...((saved && saved.apps) || {}) } };
    }
    let folders = data.folders.map((f) => ({ ...f }));
    let widgets = widgetsEnabled ? opts.widgets.map((w) => ({ ...w })) : [];
    // 个人连结图示（用户自己加的网址）
    let links = ((opts && opts.links) || []).map((l) => ({ ...l }));
    // App 位置（只记录目前有权限的）
    let layout = new Map(data.layout.map((l) => [l.module_id, { folder_id: l.folder_id, sort_order: l.sort_order }]));
    if (uninitialized) data.modules.forEach((m, i) => layout.set(m.id, { folder_id: null, sort_order: i + 1 }));

    let editing = false;
    let sheet = null; // "apps" | "widgets" | null
    let fabOpen = false;
    let lastDragEnd = 0;
    let clockTimer = null;

    // ------------------------------------------------------------ 资料：格子位置（slot）
    /* 主画面是一个固定格子的棋盘（手机 4 栏、平板 6 栏、电脑 8 栏）。
       每个东西记一个 slot（= 第几格，从 0 开始）：row = slot ÷ 栏数，col = slot mod 栏数。
       App / 文件夹占 1×1；小工具 small 2×2、medium 4×2、large 4×4。
       Notice Board 固定在棋盘上方，不在格子里。 */
    const isPinned = (w) => !!(w && WIDGETS[w.widget_type] && WIDGETS[w.widget_type].pinned);
    const board = () => widgets.find(isPinned) || null;
    const SIZES = { small: [2, 2], medium: [4, 2], large: [4, 4] };
    const cols = () => (matchMedia("(min-width: 1024px)").matches ? 8 : matchMedia("(min-width: 640px)").matches ? 6 : 4);

    function rootItems() {
      const items = [];
      layout.forEach((l, id) => modules.has(id) && !l.folder_id && items.push({ kind: "app", id, slot: l.sort_order, w: 1, h: 1 }));
      links.filter((l) => !l.folder_id).forEach((l) => items.push({ kind: "link", id: l.id, slot: l.sort_order, w: 1, h: 1 }));
      folders.forEach((f) => items.push({ kind: "folder", id: f.id, slot: f.sort_order, w: 1, h: 1 }));
      widgets.filter((w) => !isPinned(w) && !isFloating(w)).forEach((w) => items.push({ kind: "widget", id: w.id, slot: w.sort_order, w: SIZES[w.size][0], h: SIZES[w.size][1] }));
      return items.sort((a, b) => a.slot - b.slot || a.kind.localeCompare(b.kind));
    }
    const folderLinks = (fid) => links.filter((l) => l.folder_id === fid).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    const folderApps = (fid) =>
      [...layout.entries()]
        .filter(([id, l]) => l.folder_id === fid && modules.has(id))
        .sort((a, b) => a[1].sort_order - b[1].sort_order)
        .map(([id]) => id);

    // 把 slot 换算成实际位置；重叠的（例如换了装置、栏数不同）往后找空位，只影响显示不改资料
    function positions(skip) {
      const n = cols();
      const taken = new Set();
      const free = (c, r, w, h) => {
        for (let y = r; y < r + h; y++) for (let x = c; x < c + w; x++) if (taken.has(y * n + x)) return false;
        return true;
      };
      const take = (c, r, w, h) => {
        for (let y = r; y < r + h; y++) for (let x = c; x < c + w; x++) taken.add(y * n + x);
      };
      const pos = new Map();
      rootItems().forEach((it) => {
        if (skip && skip.kind === it.kind && skip.id === it.id) return;
        let slot = Math.max(0, it.slot || 0);
        let c = Math.min(slot % n, n - it.w);
        let r = Math.floor(slot / n);
        while (!free(c, r, it.w, it.h)) {
          slot++;
          c = Math.min(slot % n, n - it.w);
          r = Math.floor(slot / n);
        }
        take(c, r, it.w, it.h);
        pos.set(it.kind + ":" + it.id, { c, r, w: it.w, h: it.h, slot: r * n + c });
      });
      return { pos, taken, n, free, take };
    }
    const rowsUsed = (P) => Math.max(0, ...[...P.pos.values()].map((p) => p.r + p.h));
    // 第一个放得下的空位
    function nextSlot(w, h, P) {
      P = P || positions();
      for (let slot = 0; ; slot++) {
        const c = slot % P.n, r = Math.floor(slot / P.n);
        if (c + w > P.n) continue;
        if (P.free(c, r, w, h)) return r * P.n + c;
      }
    }

    async function saveApps(items) {
      if (readOnly || !items.length) return;
      const { error } = await sb.rpc("gw_save_layout", { p_items: items.map((i) => ({ ...i, card_size: "large" })) });
      if (error) toast(t("home.saveFailed"));
    }
    // 记住某个东西的位置
    async function saveSlot(kind, id, slot) {
      if (readOnly) return;
      if (kind === "app") {
        layout.set(id, { folder_id: null, sort_order: slot });
        return saveApps([{ module_id: id, folder_id: null, sort_order: slot }]);
      }
      if (kind === "folder") {
        const f = folders.find((x) => x.id === id);
        if (f) f.sort_order = slot;
        return sb.from("gw_user_folders").update({ sort_order: slot }).eq("id", id);
      }
      if (kind === "link") {
        const l = links.find((x) => x.id === id);
        if (l) l.sort_order = slot;
        return sb.from("gw_user_links").update({ sort_order: slot }).eq("id", id);
      }
      const w = widgets.find((x) => x.id === id);
      if (w) w.sort_order = slot;
      return sb.from("gw_user_widgets").update({ sort_order: slot }).eq("id", id);
    }

    async function addApp(id, slot) {
      if (layout.has(id) && modules.has(id)) return;
      if (slot == null) slot = nextSlot(1, 1);
      layout.set(id, { folder_id: null, sort_order: slot });
      draw();
      await saveApps([{ module_id: id, folder_id: null, sort_order: slot }]);
      sb.rpc("gw_mark_seen", { p_modules: [id] });
      toast(t("home.added"));
    }

    async function removeApp(id) {
      layout.delete(id);
      draw();
      const { error } = await sb.from("gw_user_layout").delete().eq("module_id", id).eq("user_id", data.profile.id);
      if (error) toast(t("home.saveFailed"));
    }

    async function moveLinkToFolder(id, fid) {
      const l = links.find((x) => x.id === id);
      if (!l) return;
      const order = fid ? folderLinks(fid).length + 1 : nextSlot(1, 1);
      l.folder_id = fid;
      l.sort_order = order;
      draw();
      const { error } = await sb.from("gw_user_links").update({ folder_id: fid, sort_order: order }).eq("id", id);
      if (error) {
        l.folder_id = null;
        draw();
        toast(t("home.saveFailed"));
      }
    }

    async function moveIntoFolder(id, fid) {
      const order = folderApps(fid).length + 1;
      layout.set(id, { folder_id: fid, sort_order: order });
      draw();
      await saveApps([{ module_id: id, folder_id: fid, sort_order: order }]);
    }

    // 新增的小工具放在页面上的空位：不压到 Notice Board、各区块、也不压到别的小工具；
    // 找不到空位（区块都占满整行）就放在所有内容的下面
    function freeSpot(pw, ph, ignore) {
      const rr = root.getBoundingClientRect();
      const rel = (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.left - rr.left, y: r.top - rr.top, w: r.width, h: r.height };
      };
      const rects = $$(".gw-pinned, [data-box], [data-sec-key=home] > section", root).map(rel);
      widgets.filter((w) => isFloating(w) && !w.config.pos.box && !(ignore && ignore.has(w.id))).forEach((w) => rects.push({ x: w.config.pos.x, y: w.config.pos.y, w: w.config.pos.w, h: w.config.pos.h }));
      const hit = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
      const bottom = Math.max(0, ...rects.map((r) => r.y + r.h));
      const board = $(".gw-pinned", root);
      const startY = snapY((board ? rel(board).y + rel(board).h : 0) + 16);
      const maxX = Math.max(0, root.clientWidth - pw);
      for (let y = startY; y <= bottom; y += GY)
        for (let x = 0; x <= maxX; x += GX) if (!rects.some((r) => hit({ x, y, w: pw, h: ph }, r))) return { x, y };
      return { x: 0, y: Math.ceil((bottom + 16) / GY) * GY };
    }

    async function addWidget(type, size) {
      if (!widgetsEnabled) return toast(t("widgets.unavailable"));
      const [w, h] = SIZES[size];
      let row = { user_id: data.profile.id, widget_type: type, size, sort_order: nextSlot(w, h), config: {} };
      if (sectionsOn) {
        // 区块版：新增的小工具浮在所有区块上面，之后可以拖到任何位置，或拖进某个区块
        const [pw, ph] = sizeFor(type, size);
        // 先把「新增小工具」面板收起来重画（面板打开时页面会多出一块空的 My Home，量到的位置会偏低）
        if (sheet) ((sheet = null), draw());
        row = { ...row, sort_order: 0, config: { pos: { box: null, ...freeSpot(pw, ph), w: pw, h: ph } } };
      }
      const { data: created, error } = await sb.from("gw_user_widgets").insert(row).select().single();
      if (error) return toast(t("home.saveFailed"));
      widgets.push(created);
      sheet = null;
      draw();
      toast(t("widgets.added"));
      if (!sectionsOn)
        setTimeout(() => {
          const el = root.querySelector(`[data-kind="widget"][data-id="${created.id}"]`);
          if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 50);
    }

    async function removeWidget(id) {
      if (isPinned(widgets.find((w) => w.id === id))) return;
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
      if (m.image_url)
        return `<span class="gw-icon relative flex ${size || "size-14 sm:size-16"} overflow-hidden rounded-[26%] bg-white"><img src="${esc(m.image_url)}" alt="" class="size-full object-cover">${newDot(m)}</span>`;
      return `<span class="gw-icon relative flex ${size || "size-14 sm:size-16"} items-center justify-center rounded-[26%] bg-gradient-to-br ${tileColor(m.code, m.id)} text-white">
        ${m.icon === "link" ? icon("link", "size-7 sm:size-8") : moduleIcon(m.icon, "size-7 sm:size-8")}${newDot(m)}
      </span>`;
    }

    // 个人连结图示
    function linkTile(l) {
      return `<div data-kind="link" data-id="${l.id}" class="gw-item relative flex flex-col items-center gap-1.5 pt-1">
        <button type="button" data-open-link="${l.id}" class="flex flex-col items-center gap-1.5" title="${esc(l.url)}">
          ${appIcon({ code: l.name, icon: l.icon, image_url: l.image_url })}
          <span class="w-20 truncate text-center text-xs font-medium text-slate-700 dark:text-slate-200">${esc(l.name)}</span>
        </button>
        ${editing ? badge(`data-remove-link="${l.id}"`, "minus", t("home.removeFromHome"), "top-0 left-1/2 -translate-x-[2.4rem]") + badge(`data-edit-link="${l.id}"`, "pencil", t("home.editLink"), "top-0 left-1/2 translate-x-[1rem]") : ""}
      </div>`;
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
      const minis = [
        ...ids.map((id) => `<span class="aspect-square rounded-[28%] bg-gradient-to-br ${tileColor(modules.get(id).code, id)}"></span>`),
        ...folderLinks(f.id).map((l) => `<span class="aspect-square rounded-[28%] bg-gradient-to-br ${tileColor(l.name)}"></span>`),
      ].slice(0, 9).join("");
      return `<div data-kind="folder" data-id="${f.id}" class="gw-item relative flex flex-col items-center gap-1.5 pt-1">
        <button type="button" data-folder="${f.id}" class="flex flex-col items-center gap-1.5">
          <span class="grid size-14 grid-cols-3 grid-rows-3 content-start gap-1 gw-icon rounded-[26%] border border-white/60 bg-white/50 p-2 backdrop-blur-xl sm:size-16 dark:border-white/10 dark:bg-white/10">${minis}</span>
          <span class="w-20 truncate text-center text-xs font-medium text-slate-700 dark:text-slate-200">${esc(f.name)}</span>
        </button>
        ${editing ? badge(`data-remove-folder="${f.id}"`, "minus", t("home.deleteFolder"), "top-0 left-1/2 -translate-x-[2.4rem]") : ""}
      </div>`;
    }

    const glass =
      "relative h-full overflow-hidden rounded-3xl border border-white/60 bg-white/45 p-4 shadow-xl shadow-slate-900/10 ring-1 ring-white/40 backdrop-blur-2xl backdrop-saturate-150 ring-inset dark:border-white/10 dark:bg-slate-900/45 dark:ring-white/5";
    const wTitle = (ic, text) => `<div class="mb-2 flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">${icon(ic, "size-3.5")}${esc(text)}</div>`;

    // 表情反应：按表情 = 加 / 取消自己的反应；点旁边的数字 = 看是谁按的
    function reactionBar(a) {
      if (!reactionsOn || readOnly) return "";
      return `<div class="no-drag mt-1.5 flex flex-wrap gap-1.5">${REACT.map(([k, e]) => {
        const rs = reactions.filter((r) => r.announcement_id === a.id && r.emoji === k);
        const mine = rs.some((r) => r.user_id === profile.id);
        return `<span class="inline-flex items-center overflow-hidden rounded-full border text-xs ${mine ? "border-brand-500 bg-brand-50 dark:bg-brand-700/20" : "border-slate-200 bg-white/60 dark:border-slate-700 dark:bg-white/5"}">
          <button type="button" data-react="${a.id}:${k}" aria-label="${esc(t("widgets.react." + k))}" title="${esc(t("widgets.react." + k))}" class="px-2 py-0.5 hover:bg-white/70 dark:hover:bg-white/10">${e}</button>
          ${rs.length ? `<button type="button" data-who="${a.id}:${k}" title="${esc(rs.map((r) => r.full_name || "").filter(Boolean).join(", "))}" class="border-l border-slate-200 px-1.5 py-0.5 font-semibold hover:bg-white/70 dark:border-slate-700 dark:hover:bg-white/10">${rs.length}</button>` : ""}
        </span>`;
      }).join("")}</div>`;
    }
    async function toggleReaction(aid, kind) {
      const mine = reactions.find((r) => r.announcement_id === aid && r.emoji === kind && r.user_id === profile.id);
      if (mine) {
        reactions = reactions.filter((r) => r !== mine);
        draw();
        const { error } = await sb.from("gw_notice_reactions").delete().eq("announcement_id", aid).eq("user_id", profile.id).eq("emoji", kind);
        if (error) toast(t("home.saveFailed"));
        return;
      }
      reactions.push({ announcement_id: aid, emoji: kind, user_id: profile.id, full_name: profile.full_name });
      draw();
      const { error } = await sb.from("gw_notice_reactions").insert({ announcement_id: aid, user_id: profile.id, emoji: kind });
      if (error) {
        reactions = reactions.filter((r) => !(r.announcement_id === aid && r.emoji === kind && r.user_id === profile.id));
        draw();
        toast(t("home.saveFailed"));
      }
    }
    // 谁按了这个反应
    function whoReacted(aid, kind) {
      const emoji = REACT.find(([k]) => k === kind)[1];
      const rs = reactions.filter((r) => r.announcement_id === aid && r.emoji === kind);
      const dlg = modal(
        `${emoji} ${t("widgets.react." + kind)}`,
        rs.length
          ? `<ul class="space-y-1.5">${rs.map((r) => `<li class="flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm dark:border-slate-800"><span class="flex size-7 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold dark:bg-slate-700">${esc((r.full_name || "?").slice(0, 1))}</span><span class="truncate">${esc(r.full_name || "—")}${r.user_id === profile.id ? ` <span class="text-xs text-slate-400">(${esc(t("widgets.you"))})</span>` : ""}</span></li>`).join("")}</ul>`
          : `<p class="text-sm text-slate-500">${esc(t("widgets.noReactions"))}</p>`,
      );
      return dlg;
    }

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
            <div data-clock class="font-bold tabular-nums ${w.size === "small" ? "text-3xl" : "text-5xl"}">${esc(fmt({ hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }))}</div>
            <div class="mt-1 text-sm text-slate-500">${esc(fmt({ weekday: "short", day: "numeric", month: "short" }))}</div>
          </div>`;
        case "ai":
          return aiBody();
        case "weather":
          return `<div data-weather="${w.size === "small" ? "small" : "medium"}" class="h-full">${weatherInner(w.size === "small" ? "small" : "medium")}</div>`;
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
        case "announcements": {
          // Notice Board：公告；管理员可以直接在这里发布
          const when = (d) => (d ? new Intl.DateTimeFormat(GW.LOCALE, { day: "numeric", month: "short" }).format(new Date(d)) : "");
          return `<div class="mb-2 flex items-center justify-between gap-2">
              <div class="flex items-center gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-100">${icon("megaphone", "size-4 text-brand-600 dark:text-brand-400")}${esc(t("widgets.types.announcements"))}</div>
              ${canPost && !readOnly && !editing ? `<button type="button" data-post class="no-drag flex items-center gap-1 rounded-full bg-slate-900 px-2.5 py-1 text-xs font-semibold text-white hover:bg-slate-700 dark:bg-white dark:text-slate-900">${icon("plus", "size-3.5")}${esc(t("widgets.post"))}</button>` : ""}
            </div>
            ${
              data.announcements.length
                ? `<ul class="no-drag -mr-2 space-y-2 overflow-y-auto pr-2 h-[calc(100%-2.25rem)]">${data.announcements
                    .map(
                      (a) => `<li class="flex gap-2.5 rounded-xl px-3 py-2 text-sm ${a.level === "warning" ? "bg-amber-100/60 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200" : "bg-white/50 dark:bg-white/5"}">${icon(a.level === "warning" ? "triangle-alert" : "info", `mt-0.5 size-4 shrink-0 ${a.level === "warning" ? "text-amber-500" : "text-sky-500"}`)}<div class="min-w-0 flex-1"><p class="whitespace-pre-line break-words">${esc(a.message)}</p><p class="mt-0.5 text-[11px] text-slate-400">${esc([when(a.starts_at), a.author].filter(Boolean).join(" · "))}</p>${reactionBar(a)}</div>${
                        !editing && (canEditNotice(a) || canDeleteNotice(a))
                          ? `<span class="flex shrink-0 items-start gap-0.5">${canEditNotice(a) ? `<button type="button" data-edit-notice="${a.id}" aria-label="${esc(t("widgets.editNotice"))}" title="${esc(t("widgets.editNotice"))}" class="rounded p-1 text-slate-400 hover:bg-white hover:text-slate-700 dark:hover:bg-white/10">${icon("pencil", "size-3.5")}</button>` : ""}${canDeleteNotice(a) ? `<button type="button" data-del-notice="${a.id}" aria-label="${esc(t("widgets.deleteNotice"))}" title="${esc(t("widgets.deleteNotice"))}" class="rounded p-1 text-slate-400 hover:bg-white hover:text-red-600 dark:hover:bg-white/10">${icon("trash-2", "size-3.5")}</button>` : ""}</span>`
                          : ""
                      }</li>`,
                    )
                    .join("")}</ul>`
                : `<div class="flex h-[calc(100%-2.25rem)] flex-col items-center justify-center gap-1 text-center text-sm text-slate-400">${icon("inbox", "size-6")}<span>${esc(t("widgets.noAnnouncements"))}</span></div>`
            }`;
        }
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

    function widgetTile(w, p) {
      return `<div data-kind="widget" data-id="${w.id}" class="gw-item relative" style="grid-column:${p.c + 1} / span ${p.w};grid-row:${p.r + 1} / span ${p.h}">
        <div class="${glass}">${widgetBody(w)}</div>
        ${editing ? badge(`data-remove-widget="${w.id}"`, "minus", t("widgets.remove"), "-top-2 -left-2") : ""}
        ${editing && WIDGETS[w.widget_type].sizes.length > 1 ? badge(`data-resize="${w.id}"`, "scaling", t("widgets.resize"), "-right-2 -bottom-2") : ""}
      </div>`;
    }

    // Notice Board：固定在最上面、占满整行；区块版拖拉下缘调高度（高度记在这个小工具的 config.height）
    function boardHtml() {
      const w = board();
      if (!w) return "";
      const h = Number(w.config && w.config.height);
      const sized = sectionsOn && h > 0;
      return `<div data-kind="widget" data-id="${w.id}" class="gw-pinned relative mb-4 ${sized ? "" : w.size === "large" ? "h-[22rem]" : "h-[13rem]"}" ${sized ? `style="height:${Math.round(h)}px"` : ""}>
        <div class="${glass}">${widgetBody(w)}</div>
        ${editing && !sectionsOn ? badge(`data-resize="${w.id}"`, "scaling", t("widgets.resize"), "-right-2 -bottom-2") : ""}
        ${sectionsOn ? `<div data-board-resize title="${esc(t("widgets.resize"))}" aria-label="${esc(t("widgets.resize"))}" class="absolute inset-x-0 -bottom-3 z-10 flex h-6 cursor-ns-resize touch-none items-center justify-center"><span class="h-1.5 w-14 rounded-full bg-slate-400/60 shadow backdrop-blur"></span></div>` : ""}
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
        return `<button type="button" data-done class="fixed right-5 bottom-[max(1.5rem,env(safe-area-inset-bottom))] z-40 flex h-12 items-center gap-2 rounded-full bg-slate-900 px-5 font-semibold text-white shadow-xl sm:bottom-8 dark:bg-white dark:text-slate-900">${icon("check")} ${esc(t("fab.done"))}</button>`;
      }
      const items = [
        ["tidy", "layout-grid", t("fab.tidyWidgets")],
        ["icons", "palette", t("fab.iconColors")],
        ["add-link", "link", t("fab.addLink")],
        ["add-widget", "layout-dashboard", t("fab.addWidget")],
        ["add-apps", "layout-grid", t("fab.addApps")],
        ["new-folder", "folder-plus", t("fab.newFolder")],
        ["edit", "move", t("fab.edit")],
      ];
      return `<div class="fixed right-5 bottom-[max(1.5rem,env(safe-area-inset-bottom))] z-40 flex flex-col items-end gap-2 sm:bottom-8">
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

    // ------------------------------------------------------------ Business 区块（Section box）
    /* 主页 = 上面固定的 Notice Board，下面每个 Business 一个区块：里面是这个人在这个 Business 里有权限的 App。
       区块默认只显示一行，右下角按钮展开 / 收起；里面的 App 可以拖拉排顺序（只记在自己的主页）；
       区块里可以建文件夹、放便条（以后会有更多小工具）。最后还有一个「My Links」区块放自己加的网址图示。 */
    const S = opts && opts.sections ? opts.sections : null;
    const sectionsOn = !!S && !readOnly;
    let sItems = S ? S.items.map((x) => ({ ...x })) : [];
    const expanded = new Map(S ? S.state.map((x) => [x.group_id, !!x.expanded]) : []);
        let menuGid = null; // 打开着「+」选单的区块
    let companyMenuGid = null; // 打开着 Company 选单的区块
    // 每个区块选的 Company（"all" = 全部）：记在 Notice Board 小工具的 config.companies；没选过就用自己在那个 Business 的 Company
    const companySel = new Map(Object.entries(((opts && opts.widgets) || []).find((w) => w.widget_type === "announcements")?.config?.companies || {}));
    const companiesOf = (gid) => {
      const ids = new Set(S.bizCompanies.filter((x) => x.group_id === gid).map((x) => x.company_id));
      return S.companies.filter((c) => ids.has(c.id));
    };
    const selectedCompany = (gid) => {
      const list = companiesOf(gid);
      if (list.length < 2) return "all"; // 只有一个 Company：不用选，全部显示
      // 一定选一个 Company：自己选过的 → 自己的 Company → 第一个
      const v = companySel.get(gid) || S.myCompany[gid];
      return list.some((c) => c.id === v) ? v : list[0].id;
    };
    // 模块有标 Company 的，只在选了那个 Company（或选全部）时显示；没标 Company 的模块一律显示
    const shownFor = (gid, moduleId) => {
      const sel = selectedCompany(gid);
      if (sel === "all") return true;
      const tags = S.moduleCompanies.filter((x) => x.module_id === moduleId);
      return !tags.length || tags.some((x) => x.company_id === sel);
    };
    let sortables = [];
    const bySort = (a, b) => (a.sort_order || 0) - (b.sort_order || 0);
    const modsOfGroup = (gid) => {
      const ids = new Set(S.groupModules.filter((x) => x.group_id === gid).map((x) => x.module_id));
      return data.modules.filter((m) => ids.has(m.id));
    };
    // 区块最上层的东西：有记录的按记录排；还没记录的 App 按默认顺序补在后面
    function boxItems(gid) {
      const mods = new Map(modsOfGroup(gid).map((m) => [m.id, m]));
      const own = sItems.filter((x) => x.group_id === gid && !x.parent_id && (x.kind !== "module" || (mods.has(x.module_id) && shownFor(gid, x.module_id)))).sort(bySort);
      const have = new Set(sItems.filter((x) => x.group_id === gid && x.kind === "module").map((x) => x.module_id));
      let n = own.length ? own[own.length - 1].sort_order : 0;
      const extra = [...mods.values()].filter((m) => !have.has(m.id) && shownFor(gid, m.id)).map((m) => ({ id: "new:" + m.id, virtual: true, group_id: gid, kind: "module", module_id: m.id, parent_id: null, sort_order: ++n }));
      return [...own, ...extra];
    }
    const folderKids = (fid) => sItems.filter((x) => x.parent_id === fid && modules.has(x.module_id) && shownFor(x.group_id, x.module_id)).sort(bySort);

    const TILE_H = "h-[6.25rem]";
    const ROW_PX = 100;
    // ---- 区块的大小：宽度（占一整行的比例）和展开时的高度，记在 Notice Board 小工具的 config.layout
    const CELL_W = 104; // 一格的宽度：区块宽度按整数栏吸附，间距才会平均
    const PAD_W = 48; // 区块左右的内距（外层 8×2 + 区块 16×2）
    const secLayout = (key) => ({ w: 1, h: null, cols: null, mode: null, ...((board() && board().config && board().config.layout && board().config.layout[key]) || {}) });
    // 三种大小：title = 只看标题（Business 和 Company 名字）；row = 第一行 App；full = 全部 App
    const modeOf = (key) => secLayout(key).mode || (expanded.get(key) ? "full" : "row");
    const MODES = ["title", "row", "full"];
    // 先改画面用的资料（马上重画才会看到），再存到数据库
    function setLayout(key, patch) {
      const bw = board();
      if (!bw) return null;
      const layout = { ...((bw.config && bw.config.layout) || {}), [key]: { ...secLayout(key), ...patch } };
      bw.config = { ...(bw.config || {}), layout };
      return bw;
    }
    async function saveLayout(key, patch) {
      const bw = setLayout(key, patch);
      if (!bw) return;
      const { error } = await sb.from("gw_user_widgets").update({ config: bw.config }).eq("id", bw.id);
      if (error) toast(t("home.saveFailed"));
    }
    const boxCols = (key) => {
      const fit = Math.max(2, Math.floor(((root.clientWidth || 1000) - PAD_W) / CELL_W));
      return Math.max(2, Math.min(fit, secLayout(key).cols || fit));
    };
    const widthOf = (it, n) => (it.kind === "note" ? Math.min(2, n) : 1);

    /* 区块里每个东西的位置记的是「第几行第几栏」（行 × 100 + 栏）：放哪就在哪，中间可以空着，不会自己挤在一起。
       重叠的（例如区块被拉窄了）往后找空位，只影响显示、不改资料；还没记位置的 App 补在最前面的空位。 */
    function boxPositions(gid, skipId) {
      const n = boxCols(gid);
      const all = boxItems(gid).filter((x) => x.id !== skipId);
      const taken = new Set();
      const pos = new Map();
      const free = (c, r, w) => {
        for (let x = c; x < c + w; x++) if (taken.has(r * 100 + x)) return false;
        return true;
      };
      const put = (it, c, r) => {
        const w = widthOf(it, n);
        if (c + w > n) c = Math.max(0, n - w);
        while (!free(c, r, w)) {
          c += 1;
          if (c + w > n) ((c = 0), (r += 1));
        }
        for (let x = c; x < c + w; x++) taken.add(r * 100 + x);
        pos.set(it.id, { c, r, w, slot: r * 100 + c });
      };
      all.filter((x) => !x.virtual).forEach((it) => put(it, (it.sort_order || 0) % 100, Math.floor((it.sort_order || 0) / 100)));
      all.filter((x) => x.virtual).forEach((it) => put(it, 0, 0));
      const rows = Math.max(1, ...[...pos.values()].map((p) => p.r + 1));
      return { pos, n, rows, items: all };
    }

    const placeStyle = (p) => `style="grid-column:${p.c + 1} / span ${p.w};grid-row:${p.r + 1}"`;
    const sTile = (it, p) => {
      const base = `data-key="${it.id}" ${placeStyle(p)} class="gw-item ${TILE_H}`;
      if (it.kind === "module") {
        const m = modules.get(it.module_id);
        return `<div ${base} relative flex flex-col items-center gap-1.5 pt-1" data-kind="module">
          <button type="button" data-open="${m.id}" class="flex flex-col items-center gap-1.5" title="${esc(m.description || m.name)}">
            ${appIcon(m)}
            <span class="w-20 truncate text-center text-xs font-medium text-slate-700 dark:text-slate-200">${esc(m.name)}</span>
          </button></div>`;
      }
      if (it.kind === "folder") {
        const kids = folderKids(it.id);
        const minis = kids.slice(0, 9).map((k) => `<span class="aspect-square rounded-[28%] bg-gradient-to-br ${tileColor(modules.get(k.module_id).code, k.module_id)}"></span>`).join("");
        return `<div ${base} relative flex flex-col items-center gap-1.5 pt-1" data-kind="folder">
          <button type="button" data-open-folder="${it.id}" class="flex flex-col items-center gap-1.5">
            <span class="grid size-14 grid-cols-3 grid-rows-3 content-start gap-1 gw-icon rounded-[26%] border border-white/60 bg-white/50 p-2 backdrop-blur-xl sm:size-16 dark:border-white/10 dark:bg-white/10">${minis}</span>
            <span class="w-20 truncate text-center text-xs font-medium text-slate-700 dark:text-slate-200">${esc(it.name || "")}</span>
          </button></div>`;
      }
      // 便条
      return `<div ${base} pt-1" data-kind="note">
        <button type="button" data-open-note="${it.id}" class="flex h-[5.75rem] w-full flex-col items-start overflow-hidden gw-icon rounded-2xl border border-white/50 bg-amber-200/60 p-3 text-left text-amber-950 backdrop-blur-xl dark:bg-amber-200/70">
          <span class="flex w-full items-center gap-1.5 text-xs font-semibold">${icon("sticky-note", "size-3.5")}<span class="truncate">${esc(it.name || t("home.noteDefault"))}</span></span>
          <span class="mt-1 line-clamp-3 w-full text-xs whitespace-pre-line break-words">${esc(it.body || "")}</span>
        </button></div>`;
    };
    const secGrip = () => `<span class="sec-grip cursor-grab touch-none rounded p-0.5 text-slate-400 hover:text-slate-600 active:cursor-grabbing" title="${esc(t("home.moveSection"))}" aria-label="${esc(t("home.moveSection"))}">${icon("grip-vertical", "size-4")}</span>`;
    // 区块（各 Business 和 My Home）的先后顺序，记在 Notice Board 小工具的 config.order
    const sectionOrder = () => {
      const w = board();
      return w && w.config && Array.isArray(w.config.order) ? w.config.order : [];
    };
    // 右下角：拖拉调整区块大小
    const resizeGrip = (key) => `<span data-sec-resize="${key}" title="${esc(t("home.resizeSection"))}" aria-label="${esc(t("home.resizeSection"))}" class="absolute right-1.5 bottom-1.5 z-20 flex size-5 cursor-nwse-resize touch-none items-end justify-end text-slate-400 hover:text-slate-600"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M11 1 1 11M11 6 6 11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></span>`;

    // 一个 Business 的区块：三种大小（只看标题 / 第一行 / 全部）；里面的 App 一定会显示（这个 Business 有的模块）
    function boxShell({ key, title, mode, tiles, n, rows, widgetsHtml }) {
      const lay = secLayout(key);
      const open = mode === "full";
      const R = open ? rows + 1 : rows;
      const body = tiles || `<p class="col-span-full row-start-1 px-1 py-3 text-sm text-slate-500">${esc(t("home.noAppsForCompany"))}</p>`;
      const wrapW = lay.cols ? `${n * CELL_W + PAD_W}px` : "100%";
      const step = (dir, ic, label, off) => `<button type="button" data-mode="${dir}" aria-label="${esc(label)}" title="${esc(label)}" ${off ? "disabled" : ""} class="shrink-0 rounded-lg p-1.5 text-slate-500 hover:bg-white/60 disabled:pointer-events-none disabled:opacity-25 dark:hover:bg-white/10">${icon(ic, "size-4")}</button>`;
      return `<div data-sec-wrap data-sec-key="${key}" class="p-2" style="width:${wrapW};max-width:100%">
        <section data-box="${key}" class="${glass} h-auto! overflow-visible! ${mode === "title" ? "pb-3" : "pb-6"} ${companyMenuGid === key ? "z-30" : ""}">
          <div class="${mode === "title" ? "" : "mb-2"} flex items-center justify-between gap-2">
            <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">${secGrip()}<h2 class="truncate text-base font-bold text-slate-800 dark:text-slate-100">${esc(title)}</h2>${companyPicker(key)}</div>
            <div class="flex shrink-0 items-center">${step("less", "chevron-up", t("home.collapse"), mode === "title")}${step("more", "chevron-down", t("home.expand"), mode === "full")}</div>
          </div>
          <div data-list="${key}" data-fw-host="${key}" data-cols="${n}" class="relative mx-auto grid gap-x-0 overflow-hidden ${mode === "title" ? "hidden" : ""} ${mode === "row" ? "max-h-[6.25rem]" : ""}" style="width:${n * CELL_W}px;max-width:100%;grid-template-columns:repeat(${n},${CELL_W}px);grid-template-rows:repeat(${R},${ROW_PX}px);${open && lay.h ? `min-height:${lay.h}px;` : ""}">${body}<div data-box-hint class="pointer-events-none hidden rounded-2xl border-2 border-dashed"></div>${widgetsHtml || ""}</div>
          ${mode === "title" ? "" : resizeGrip(key)}
        </section></div>`;
    }
    // 区块标题旁边的 Company 选择
    const companyPicker = (gid) => {
      const list = companiesOf(gid);
      if (!list.length) return "";
      // 只有一个 Company：只显示它的名字，不用下拉选单
      if (list.length === 1) return `<span class="inline-flex max-w-[14rem] items-center gap-1 rounded-full border border-white/60 bg-white/50 px-2.5 py-1 text-xs font-medium text-slate-700 backdrop-blur dark:border-white/10 dark:bg-white/10 dark:text-slate-200">${icon("building-2", "size-3.5 shrink-0")}<span class="truncate">${esc(list[0].name)}</span></span>`;
      const sel = selectedCompany(gid);
      const cur = list.find((c) => c.id === sel);
      const label = cur ? cur.short_name || cur.code || cur.name : list[0].name;
      const row = (id, text) => `<button type="button" data-company-pick="${id}" data-gid="${gid}" class="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800"><span class="truncate">${esc(text)}</span>${sel === id ? icon("check", "size-4 text-emerald-600") : ""}</button>`;
      return `<div class="relative">
        <button type="button" data-company-menu="${gid}" class="inline-flex max-w-[11rem] items-center gap-1 rounded-full border border-white/60 bg-white/50 px-2.5 py-1 text-xs font-medium text-slate-700 backdrop-blur hover:bg-white/70 dark:border-white/10 dark:bg-white/10 dark:text-slate-200">${icon("building-2", "size-3.5")}<span class="truncate">${esc(label)}</span>${icon("chevron-down", "size-3.5")}</button>
        ${companyMenuGid === gid ? `<div class="absolute top-full left-0 z-30 mt-1 max-h-64 w-60 overflow-y-auto rounded-xl border border-white/60 bg-white/90 p-1.5 shadow-xl backdrop-blur-xl dark:border-white/10 dark:bg-slate-900/90">${list.map((c) => row(c.id, c.name)).join("")}</div>` : ""}
      </div>`;
    };

    // 区块里的 App 记下新位置（还没记过的先建一笔；先改画面再存，不会闪回去）
    function placeInBox(gid, id, slot, parentId) {
      let it = sItems.find((x) => x.id === id);
      if (it) {
        it.sort_order = slot;
        if (parentId !== undefined) it.parent_id = parentId;
        return sb.from("gw_user_section_items").update(parentId !== undefined ? { sort_order: slot, parent_id: parentId } : { sort_order: slot }).eq("id", id).then(({ error }) => error && toast(t("home.saveFailed")));
      }
      const moduleId = id.slice(4);
      it = { id: "tmp:" + moduleId, user_id: data.profile.id, group_id: gid, kind: "module", module_id: moduleId, parent_id: parentId || null, sort_order: slot };
      sItems.push(it);
      return sb
        .from("gw_user_section_items")
        .insert({ user_id: data.profile.id, group_id: gid, kind: "module", module_id: moduleId, parent_id: parentId || null, sort_order: slot })
        .select()
        .single()
        .then(({ data: created, error }) => {
          if (error) return toast(t("home.saveFailed"));
          it.id = created.id;
        });
    }

    // ------------------------------------------------------------ 区块里拖 App：放到哪个空格就留在哪（长按 / 拖动开始）
    let bdrag = null;
    let bpress = null;
    function boxCell(list, x, y) {
      const rect = list.getBoundingClientRect();
      const n = Number(list.dataset.cols);
      const gx = parseFloat(getComputedStyle(list).columnGap) || 0;
      const cellW = (rect.width - gx * (n - 1)) / n;
      return { c: Math.max(0, Math.min(n - 1, Math.floor((x - rect.left) / (cellW + gx)))), r: Math.max(0, Math.floor((y - rect.top) / ROW_PX)), n, cellW, gx };
    }
    function boxTarget(e) {
      const { list, gid, id, w } = bdrag;
      const g = boxCell(list, e.clientX, e.clientY);
      const P = boxPositions(gid, id);
      const maxR = modeOf(gid) === "full" ? P.rows : 0; // 只显示第一行时，只能放在第一行
      const c = Math.max(0, Math.min(g.n - w, g.c - bdrag.offC));
      const r = Math.min(g.r, maxR);
      const hits = new Set();
      P.pos.forEach((p, key) => {
        if (r === p.r && c < p.c + p.w && c + w > p.c) hits.add(key);
      });
      let action = null;
      if (!hits.size) action = { type: "place", c, r };
      else if (hits.size === 1) {
        const key = [...hits][0];
        const it = P.items.find((x) => x.id === key);
        const p = P.pos.get(key);
        if (it.kind === "folder" && bdrag.kind === "module") action = { type: "folder", fid: key };
        else if (w === 1 && p.w === 1) action = { type: "swap", key, theirs: p.slot };
      }
      return { c, r, action };
    }
    function startBoxDrag(e, el) {
      const list = el.parentElement;
      const gid = list.dataset.list;
      const id = el.dataset.key;
      const p = boxPositions(gid).pos.get(id);
      const rect = el.getBoundingClientRect();
      const g = boxCell(list, rect.left, rect.top);
      const w = p ? p.w : 1;
      bdrag = { el, list, gid, id, kind: el.dataset.kind, w, slot: p ? p.slot : 0, offC: Math.min(w - 1, Math.floor((e.clientX - rect.left) / (g.cellW + g.gx))), dx: e.clientX - rect.left, dy: e.clientY - rect.top, target: null };
      const ghost = el.cloneNode(true);
      ghost.removeAttribute("data-key");
      ghost.style.cssText = `position:fixed;left:0;top:0;width:${rect.width}px;height:${rect.height}px;z-index:60;pointer-events:none;transform:translate(${rect.left}px,${rect.top}px) scale(1.08);opacity:.95;transition:none;margin:0`;
      ghost.className = ghost.className.replace("gw-item", "gw-ghost");
      document.body.appendChild(ghost);
      bdrag.ghost = ghost;
      el.classList.add("opacity-30");
      document.body.classList.add("gw-dragging");
    }
    function moveBoxDrag(e) {
      bdrag.ghost.style.transform = `translate(${e.clientX - bdrag.dx}px,${e.clientY - bdrag.dy}px) scale(1.08)`;
      if (e.clientY < 90) scrollBy(0, -14);
      else if (e.clientY > innerHeight - 90) scrollBy(0, 14);
      bdrag.target = boxTarget(e);
      const hint = $("[data-box-hint]", bdrag.list);
      if (!hint) return;
      const tg = bdrag.target;
      hint.classList.remove("hidden");
      hint.className = `pointer-events-none rounded-2xl border-2 border-dashed ${tg.action ? "border-brand-500/70 bg-brand-500/10" : "border-rose-400/70 bg-rose-400/10"}`;
      hint.style.gridColumn = `${tg.c + 1} / span ${bdrag.w}`;
      hint.style.gridRow = `${tg.r + 1}`;
    }
    async function endBoxDrag(cancelled) {
      const d = bdrag;
      bdrag = null;
      d.ghost.remove();
      d.el.classList.remove("opacity-30");
      document.body.classList.remove("gw-dragging");
      lastDragEnd = Date.now();
      const a = !cancelled && d.target && d.target.action;
      if (!a) return draw();
      // 其他还没记过位置的 App 先照现在的位置记下来，才不会因为这一个移走就往前挤
      const keep = [];
      boxPositions(d.gid).pos.forEach((pp, key) => {
        if (key.startsWith("new:") && key !== d.id && !(a.type === "swap" && key === a.key)) keep.push(placeInBox(d.gid, key, pp.slot));
      });
      if (a.type === "place") {
        const saving = Promise.all([...keep, placeInBox(d.gid, d.id, a.r * 100 + a.c)]);
        draw();
        return saving;
      }
      if (a.type === "folder") {
        const saving = Promise.all([...keep, placeInBox(d.gid, d.id, 0, a.fid)]);
        draw();
        return saving;
      }
      if (a.type === "swap") {
        const saving = Promise.all([...keep, placeInBox(d.gid, d.id, a.theirs), placeInBox(d.gid, a.key, d.slot)]);
        draw();
        return saving;
      }
      draw();
    }
    root.addEventListener("pointerdown", (e) => {
      if (!sectionsOn || bdrag || e.button !== 0) return;
      const el = e.target.closest("[data-list] > .gw-item[data-key]");
      if (!el || e.target.closest(".no-drag")) return;
      const touch = e.pointerType !== "mouse";
      bpress = { el, x: e.clientX, y: e.clientY, id: e.pointerId, touch };
      if (touch) bpress.timer = setTimeout(() => bpress && ((bpress.hold = true), startBoxDrag(e, el), moveBoxDrag(e)), 280);
    });
    root.addEventListener("pointermove", (e) => {
      if (bdrag) return moveBoxDrag(e);
      if (!bpress || e.pointerId !== bpress.id) return;
      const far = Math.hypot(e.clientX - bpress.x, e.clientY - bpress.y) > 8;
      if (bpress.touch && far && !bdrag) (clearTimeout(bpress.timer), (bpress = null));
      else if (!bpress.touch && far) (startBoxDrag(e, bpress.el), moveBoxDrag(e), (bpress = null));
    });
    const boxUp = (e) => {
      if (bpress) (clearTimeout(bpress.timer), (bpress = null));
      if (bdrag) endBoxDrag(e.type === "pointercancel");
    };
    root.addEventListener("pointerup", boxUp);
    root.addEventListener("pointercancel", boxUp);
    addEventListener("pointerup", (e) => bdrag && boxUp(e));
    document.addEventListener("touchmove", (e) => bdrag && e.preventDefault(), { passive: false });

    // ------------------------------------------------------------ 区块右下角：拖拉调整大小（宽度按整数栏吸附，里面的 App 间距才会平均；高度 = 展开时的高度）
    root.addEventListener("pointerdown", (e) => {
      const grab = e.target.closest("[data-sec-resize]");
      if (!grab || e.button !== 0) return;
      e.preventDefault();
      const key = grab.dataset.secResize;
      const wrap = grab.closest("[data-sec-wrap]");
      const host = wrap.querySelector("[data-fw-host]");
      const rootW = root.getBoundingClientRect().width;
      const startW = wrap.getBoundingClientRect().width;
      const startH = host.getBoundingClientRect().height;
      const sx = e.clientX;
      const sy = e.clientY;
      const maxCols = Math.max(2, Math.floor((rootW - PAD_W) / CELL_W));
      let cols = key === "home" ? null : boxCols(key);
      let frac = secLayout(key).w;
      let h = startH;
      document.body.classList.add("gw-dragging");
      const move = (ev) => {
        if (key === "home") {
          frac = Math.max(0.2, Math.min(1, Math.round(((startW + ev.clientX - sx) / rootW) * 20) / 20));
          wrap.style.width = Math.round(frac * 100) + "%";
        } else {
          cols = Math.max(2, Math.min(maxCols, Math.round((startW - PAD_W + ev.clientX - sx) / CELL_W)));
          wrap.style.width = cols * CELL_W + PAD_W + "px";
        }
        h = Math.max(ROW_PX, Math.round((startH + ev.clientY - sy) / (ROW_PX / 2)) * (ROW_PX / 2));
        host.style.maxHeight = "none";
        host.style.minHeight = h + "px";
      };
      const up = async () => {
        removeEventListener("pointermove", move);
        removeEventListener("pointerup", up);
        removeEventListener("pointercancel", up);
        document.body.classList.remove("gw-dragging");
        lastDragEnd = Date.now();
        const grew = h > ROW_PX + 24;
        const patch = key === "home" ? { w: frac, h: grew ? Math.round(h) : null } : { cols: cols >= maxCols ? null : cols, h: grew ? Math.round(h) : null };
        if (key !== "home" && grew && modeOf(key) !== "full") {
          patch.mode = "full";
          expanded.set(key, true);
          sb.from("gw_user_sections").upsert({ user_id: data.profile.id, group_id: key, expanded: true });
        }
        setLayout(key, patch);
        const saving = saveLayout(key, patch);
        draw();
        await saving;
      };
      addEventListener("pointermove", move);
      addEventListener("pointerup", up);
      addEventListener("pointercancel", up);
    });

    // 画完之后：让区块可以拖拉调整先后顺序
    function afterSections() {
      sortables.forEach((x) => x.destroy());
      sortables = [];
      const stack = $("#gw-stack", root);
      if (stack)
        sortables.push(
          window.Sortable.create(stack, {
            animation: 180,
            handle: ".sec-grip",
            draggable: "[data-sec-wrap]",
            delay: 120,
            delayOnTouchOnly: true,
            onEnd: async () => {
              lastDragEnd = Date.now();
              const order = $$("[data-sec-wrap]", stack).map((el) => el.dataset.secKey);
              const w = board();
              if (!w) return;
              w.config = { ...(w.config || {}), order };
              const { error } = await sb.from("gw_user_widgets").update({ config: w.config }).eq("id", w.id);
              if (error) toast(t("home.saveFailed"));
            },
          }),
        );
    }
    const drawSections = () => draw();
    // 窗口宽度变了、区块的栏数跟着变时重画
    let lastBoxCols = "";
    const boxColsSig = () => (sectionsOn ? S.groups.map((g) => boxCols(g.id)).join(",") : "");
    addEventListener("resize", () => {
      if (!sectionsOn) return;
      const sig = boxColsSig();
      if (sig !== lastBoxCols) ((lastBoxCols = sig), draw());
    });

    // ------------------------------------------------------------ 浮动小工具：新增的小工具浮在所有区块上面，可以放在任何位置；拖进某个区块就留在那个区块里
    const GX = CELL_W / 2;
    const GY = ROW_PX / 2; // 小工具的位置和大小按半格吸附，才好对齐、好置中
    const snapX = (v) => Math.round(v / GX) * GX;
    const snapY = (v) => Math.round(v / GY) * GY;
    const FW_MIN = [GX * 3, GY * 2];
    const SIZE_PX = { small: [CELL_W * 2, ROW_PX * 2], medium: [CELL_W * 4, ROW_PX * 2], large: [CELL_W * 4, ROW_PX * 4] };
    // 有些小工具内容比较高（月历），预设大小照内容来，才不会被切掉
    const SIZE_BY_TYPE = {
      calendar: { small: [CELL_W * 2, ROW_PX * 3], medium: [CELL_W * 4, ROW_PX * 3] },
      ai: { medium: [CELL_W * 4, ROW_PX * 5], large: [CELL_W * 6, ROW_PX * 7] },
      recent: { small: [CELL_W * 2, ROW_PX * 2], medium: [CELL_W * 4, ROW_PX * 2] },
      notes: { small: [CELL_W * 2, ROW_PX * 2], medium: [CELL_W * 4, ROW_PX * 2], large: [CELL_W * 4, ROW_PX * 4] },
    };
    const sizeFor = (type, size) => (SIZE_BY_TYPE[type] && SIZE_BY_TYPE[type][size]) || SIZE_PX[size] || [CELL_W * 4, ROW_PX * 2];
    const isFloating = (w) => !!(w && w.config && w.config.pos);
    function floatWidget(w) {
      const p = w.config.pos;
      return `<div data-fw="${w.id}" class="gw-fw group absolute z-40 touch-none" style="left:${p.x}px;top:${p.y}px;width:${p.w}px;height:${p.h}px">
        <div class="h-full p-1.5"><div class="${glass.replace("bg-white/45", "bg-white/80").replace("dark:bg-slate-900/45", "dark:bg-slate-900/80")} cursor-grab p-3!">${widgetBody({ ...w, size: p.w < 240 ? "small" : p.h > 260 ? "large" : "medium" })}</div></div>
        <button type="button" data-remove-fw="${w.id}" aria-label="${esc(t("home.removeFromHome"))}" class="no-drag absolute -top-2 -right-2 z-10 flex size-6 items-center justify-center rounded-full bg-slate-700/90 text-white opacity-0 shadow ring-2 ring-white transition-opacity group-hover:opacity-100 dark:ring-slate-900 [@media(hover:none)]:opacity-100">${icon("x", "size-3.5")}</button>
        <span data-fw-resize class="no-drag absolute right-1.5 bottom-1.5 z-10 flex size-5 cursor-nwse-resize touch-none items-end justify-end text-slate-400 hover:text-slate-600"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M11 1 1 11M11 6 6 11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></span>
      </div>`;
    }
    const floatsIn = (host) => widgets.filter((w) => isFloating(w) && (w.config.pos.box || null) === host).map(floatWidget).join("");
    // 放下或调整大小后如果压到别的小工具（页面上的还有 Notice Board 和区块），就挪到最近的空位
    function resolveSpot(box, x, y, w, h, selfId) {
      const rr = root.getBoundingClientRect();
      const rects = widgets.filter((o) => o.id !== selfId && isFloating(o) && (o.config.pos.box || null) === (box || null)).map((o) => ({ x: o.config.pos.x, y: o.config.pos.y, w: o.config.pos.w, h: o.config.pos.h }));
      if (!box)
        $$(".gw-pinned, [data-box], [data-sec-key=home] > section", root).forEach((el) => {
          const r = el.getBoundingClientRect();
          rects.push({ x: r.left - rr.left, y: r.top - rr.top, w: r.width, h: r.height });
        });
      const hostEl = box ? $(`[data-fw-host="${box}"]`, root) : root;
      const maxX = Math.max(0, (hostEl ? hostEl.clientWidth : root.clientWidth) - w);
      const hit = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
      const ok = (cx, cy) => cx >= 0 && cx <= maxX && cy >= 0 && !rects.some((r) => hit({ x: cx, y: cy, w, h }, r));
      x = Math.min(Math.max(0, x), maxX);
      if (ok(x, y)) return { x, y };
      for (let k = 1; k <= 60; k++)
        for (let dy = -k; dy <= k; dy++)
          for (let dx = -k; dx <= k; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== k) continue;
            const cx = x + dx * GX;
            const cy = y + dy * GY;
            if (ok(cx, cy)) return { x: cx, y: cy };
          }
      return { x, y };
    }
    // 整理页面上的小工具：全部重新排整齐（照原来的上下左右顺序，贴着格线，之间留空隙）
    async function tidyWidgets() {
      const list = widgets.filter((w) => isFloating(w) && !w.config.pos.box).sort((a, b) => a.config.pos.y - b.config.pos.y || a.config.pos.x - b.config.pos.x);
      if (!list.length) return toast(t("home.nothingToTidy"));
      const pending = new Set(list.map((w) => w.id));
      for (const w of list) {
        const { w: pw, h: ph } = w.config.pos;
        const spot = freeSpot(pw, ph, pending);
        w.config = { ...w.config, pos: { ...w.config.pos, x: spot.x, y: spot.y } };
        pending.delete(w.id);
      }
      draw();
      const results = await Promise.all(list.map((w) => sb.from("gw_user_widgets").update({ config: w.config }).eq("id", w.id)));
      if (results.some((r) => r.error)) toast(t("home.saveFailed"));
    }

    // 按住小工具拖到任何位置；放在某个区块上面就变成那个区块里的小工具
    root.addEventListener("pointerdown", (e) => {
      const fw = e.target.closest("[data-fw]");
      if (!fw || e.button !== 0 || readOnly) return;
      const resizing = !!e.target.closest("[data-fw-resize]");
      if (!resizing && e.target.closest(".no-drag, button, input, textarea, select, a")) return;
      const w = widgets.find((x) => x.id === fw.dataset.fw);
      if (!w) return;
      e.preventDefault();
      const rect = fw.getBoundingClientRect();
      const sx = e.clientX;
      const sy = e.clientY;
      let moved = false;
      const p = { ...w.config.pos };
      const finish = async (box, x, y, nw, nh) => {
        const sw = Math.max(FW_MIN[0], snapX(nw));
        const sh = Math.max(FW_MIN[1], snapY(nh));
        const spot = resolveSpot(box, Math.max(0, snapX(x)), Math.max(0, snapY(y)), sw, sh, w.id);
        w.config = { ...w.config, pos: { box, x: spot.x, y: spot.y, w: sw, h: sh } };
        draw();
        const { error } = await sb.from("gw_user_widgets").update({ config: w.config }).eq("id", w.id);
        if (error) toast(t("home.saveFailed"));
      };
      if (resizing) {
        document.body.classList.add("gw-dragging");
        const move = (ev) => {
          fw.style.width = Math.max(FW_MIN[0], p.w + ev.clientX - sx) + "px";
          fw.style.height = Math.max(FW_MIN[1], p.h + ev.clientY - sy) + "px";
        };
        const up = () => {
          removeEventListener("pointermove", move);
          removeEventListener("pointerup", up);
          removeEventListener("pointercancel", up);
          document.body.classList.remove("gw-dragging");
          lastDragEnd = Date.now();
          finish(p.box || null, p.x, p.y, parseFloat(fw.style.width), parseFloat(fw.style.height));
        };
        addEventListener("pointermove", move);
        addEventListener("pointerup", up);
        addEventListener("pointercancel", up);
        return;
      }
      const move = (ev) => {
        if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
        if (!moved) {
          moved = true;
          // 拖的时候搬到 body 底下（区块有毛玻璃，里面的 fixed 位置会跑掉）
          fw.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;z-index:70`;
          document.body.appendChild(fw);
          document.body.classList.add("gw-dragging");
        }
        fw.style.left = rect.left + ev.clientX - sx + "px";
        fw.style.top = rect.top + ev.clientY - sy + "px";
        if (ev.clientY < 90) scrollBy(0, -14);
        else if (ev.clientY > innerHeight - 90) scrollBy(0, 14);
      };
      const up = (ev) => {
        removeEventListener("pointermove", move);
        removeEventListener("pointerup", up);
        removeEventListener("pointercancel", up);
        document.body.classList.remove("gw-dragging");
        lastDragEnd = Date.now();
        if (!moved) return;
        const r = fw.getBoundingClientRect();
        fw.remove();
        // 放在哪个区块上面：那个区块；都不是 = 页面上任何位置
        let host = null;
        let hostEl = root;
        for (const sec of $$("[data-box], [data-sec-key=home] > section", root)) {
          const b = sec.getBoundingClientRect();
          if (ev.clientX >= b.left && ev.clientX <= b.right && ev.clientY >= b.top && ev.clientY <= b.bottom) {
            host = sec.dataset.box || "home";
            hostEl = sec.querySelector("[data-fw-host]") || sec;
            break;
          }
        }
        const hr = hostEl.getBoundingClientRect();
        let x = r.left - hr.left;
        let y = r.top - hr.top;
        if (host) {
          x = Math.min(x, Math.max(0, hr.width - 60));
          if (host !== "home" && modeOf(host) !== "full") {
            expanded.set(host, true); // 放进收起的区块：先展开，才看得到
            sb.from("gw_user_sections").upsert({ user_id: data.profile.id, group_id: host, expanded: true });
            saveLayout(host, { mode: "full" });
          }
          if (y + r.height + 16 > (secLayout(host).h || 0)) saveLayout(host, { h: Math.round(snapY(Math.max(y, 0) + r.height) + 16) });
        } else x = Math.min(x, Math.max(0, hr.width - r.width));
        finish(host, x, y, r.width, r.height);
      };
      addEventListener("pointermove", move);
      addEventListener("pointerup", up);
      addEventListener("pointercancel", up);
    });

    // ------------------------------------------------------------ AI 助手：聊天问资料、要报表，报表可以直接下载（Excel / CSV）
    /* 问题送到 Edge Function gw-ai-chat；它用这个人自己的权限查资料。
       聊天记录只在这台装置记文字（最近 30 则）；报表的资料只留在这次打开的页面，重新整理后要再问一次才能下载。 */
    const AI_KEY = "gw_ai_chat_" + profile.id;
    let aiMsgs = [];
    try {
      aiMsgs = JSON.parse(localStorage.getItem(AI_KEY) || "[]").filter((m) => m && typeof m.text === "string");
    } catch (e) {
      /* 忽略 */
    }
    let aiBusy = false;
    let aiDraft = "";
    const aiSave = () => {
      try {
        localStorage.setItem(AI_KEY, JSON.stringify(aiMsgs.slice(-30).map((m) => ({ role: m.role, text: m.text, reports: (m.reports || []).map((r) => ({ id: r.id, title: r.title, total: r.total })) }))));
      } catch (e) {
        /* 忽略 */
      }
    };
    // 简单的 markdown：表格、列表、粗体、行内代码
    function mdLite(text) {
      const inline = (x) => esc(x).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, '<code class="rounded bg-slate-200/70 px-1 dark:bg-slate-700">$1</code>');
      const lines = String(text).split("\n");
      let out = "";
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i];
        if (/^\s*\|/.test(ln)) {
          const rows = [];
          while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
          i--;
          const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
          const body = rows.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r));
          out += `<div class="my-1 overflow-x-auto"><table class="min-w-full text-xs">${body.map((r, k) => `<tr>${cells(r).map((c) => (k === 0 ? `<th class="border-b border-slate-300 px-2 py-1 text-left font-semibold">${inline(c)}</th>` : `<td class="border-b border-slate-200/70 px-2 py-1">${inline(c)}</td>`)).join("")}</tr>`).join("")}</table></div>`;
        } else if (/^\s*[-*]\s+/.test(ln)) {
          const items = [];
          while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ""));
          i--;
          out += `<ul class="my-1 list-disc space-y-0.5 pl-4">${items.map((x) => `<li>${inline(x)}</li>`).join("")}</ul>`;
        } else if (!ln.trim()) out += '<div class="h-1.5"></div>';
        else out += `<p>${inline(ln)}</p>`;
      }
      return out;
    }
    function aiBody() {
      const ta = (k, v) => t("widgets.ai." + k, v);
      const bubble = (m, idx) =>
        m.role === "user"
          ? `<div class="flex justify-end"><div class="max-w-[85%] rounded-2xl rounded-br-md bg-brand-600 px-3 py-1.5 text-sm text-white whitespace-pre-wrap break-words">${esc(m.text)}</div></div>`
          : `<div class="flex justify-start"><div class="max-w-[92%] min-w-0 rounded-2xl rounded-bl-md bg-white/70 px-3 py-2 text-sm break-words dark:bg-white/10">${mdLite(m.text)}${(m.reports || [])
              .map(
                (r) => `<div class="mt-2 flex flex-wrap items-center gap-1.5 rounded-xl border border-slate-200 bg-white/80 p-2 dark:border-slate-700 dark:bg-slate-900/60">
                  ${icon("file-spreadsheet", "size-4 shrink-0 text-emerald-600")}<span class="min-w-0 flex-1 truncate text-xs font-semibold" title="${esc(r.title)}">${esc(r.title)}</span><span class="text-[11px] text-slate-500">${esc(ta("rows", { count: r.total }))}</span>
                  ${r.rows ? `<button type="button" data-ai-dl="${idx}:${r.id}:xlsx" class="rounded-full bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-700">${esc(ta("excel"))}</button><button type="button" data-ai-dl="${idx}:${r.id}:csv" class="rounded-full border border-slate-300 px-2.5 py-1 text-xs font-semibold hover:bg-white dark:border-slate-600">${esc(ta("csv"))}</button>` : `<span class="text-[11px] text-slate-400">${esc(ta("expired"))}</span>`}
                </div>`,
              )
              .join("")}</div></div>`;
      const intro = `<div class="space-y-2 text-sm text-slate-600 dark:text-slate-300"><p>${esc(ta("intro"))}</p><div class="flex flex-wrap gap-1.5">${[1, 2, 3].map((n) => `<button type="button" data-ai-suggest="${esc(ta("s" + n))}" class="rounded-full border border-slate-300 bg-white/70 px-2.5 py-1 text-left text-xs hover:bg-white dark:border-slate-600 dark:bg-white/10">${esc(ta("s" + n))}</button>`).join("")}</div></div>`;
      return `<div class="flex h-full min-h-0 flex-col">
        <div class="mb-2 flex items-center justify-between gap-2"><div class="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-slate-500 uppercase">${icon("bot", "size-3.5")}${esc(t("widgets.types.ai"))}</div>
          ${aiMsgs.length ? `<button type="button" data-ai-clear class="no-drag rounded-full px-2 py-0.5 text-[11px] text-slate-500 hover:bg-white/70 dark:hover:bg-white/10">${esc(ta("clear"))}</button>` : ""}</div>
        <div data-ai-log class="no-drag min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">${aiMsgs.length ? aiMsgs.map(bubble).join("") : intro}${aiBusy ? `<div class="flex justify-start"><div class="rounded-2xl rounded-bl-md bg-white/70 px-3 py-1.5 text-sm text-slate-500 dark:bg-white/10">${esc(ta("thinking"))}</div></div>` : ""}</div>
        <form data-ai-form class="no-drag mt-2 flex gap-1.5"><input data-ai-input autocomplete="off" maxlength="1000" value="${esc(aiDraft)}" placeholder="${esc(ta("placeholder"))}" ${aiBusy ? "disabled" : ""} class="${cls.input} h-9 min-w-0 flex-1 rounded-full bg-white/80 text-sm dark:bg-slate-800/80"><button type="submit" ${aiBusy ? "disabled" : ""} aria-label="${esc(ta("send"))}" class="flex size-9 shrink-0 items-center justify-center rounded-full bg-slate-900 text-white disabled:opacity-50 dark:bg-white dark:text-slate-900">${icon("send", "size-4")}</button></form>
      </div>`;
    }
    function aiAfterDraw() {
      $$("[data-ai-log]", root).forEach((el) => (el.scrollTop = el.scrollHeight));
    }
    async function aiAsk(text) {
      text = String(text || "").trim();
      if (!text || aiBusy) return;
      aiMsgs.push({ role: "user", text });
      aiDraft = "";
      aiBusy = true;
      aiSave();
      draw();
      const r = await GW.invoke("gw-ai-chat", { messages: aiMsgs.slice(-12).map((m) => ({ role: m.role, content: m.text })) });
      aiBusy = false;
      if (r && r.ok) aiMsgs.push({ role: "assistant", text: r.reply, reports: r.reports || [] });
      else aiMsgs.push({ role: "assistant", text: t("widgets.ai.errors." + ((r && r.error) || "failed"), { limit: r && r.limit }) });
      aiSave();
      draw();
      const input = $("[data-ai-input]", root);
      if (input) input.focus();
    }
    async function aiDownload(spec) {
      const [idx, rid, fmt] = spec.split(":");
      const m = aiMsgs[Number(idx)];
      const rep = m && (m.reports || []).find((x) => x.id === rid);
      if (!rep || !rep.rows) return toast(t("widgets.ai.expired"));
      const day = new Intl.DateTimeFormat("en-CA", { timeZone: GW_CONFIG.timeZone }).format(new Date());
      const base = (rep.title || "report").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 50) || "report";
      if (fmt === "xlsx")
        return GW.downloadXlsx(`${base}-${day}.xlsx`, (wb) => {
          const ws = wb.addWorksheet((rep.title || "Report").replace(/[\\/?*[\]:]/g, " ").slice(0, 30));
          ws.columns = rep.columns.map((c) => ({ header: c.label, key: c.key, width: Math.max(12, Math.min(34, c.label.length + 6)) }));
          rep.rows.forEach((row) => ws.addRow(rep.columns.map((c) => (c.type === "number" && row[c.key] !== null && row[c.key] !== "" ? Number(row[c.key]) : row[c.key] ?? ""))));
          ws.getRow(1).font = { bold: true };
          ws.views = [{ state: "frozen", ySplit: 1 }];
        });
      const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const lines = [rep.columns.map((c) => q(c.label)).join(","), ...rep.rows.map((row) => rep.columns.map((c) => (c.type === "number" && row[c.key] !== null ? row[c.key] : q(row[c.key]))).join(","))];
      GW.downloadBlob(`${base}-${day}.csv`, new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" }));
    }
    root.addEventListener("submit", (e) => {
      if (!e.target.matches("[data-ai-form]")) return;
      e.preventDefault();
      aiAsk($("[data-ai-input]", e.target).value);
    });
    root.addEventListener("input", (e) => {
      if (e.target.matches("[data-ai-input]")) aiDraft = e.target.value;
    });

    // ------------------------------------------------------------ 天气：用浏览器的位置，Open-Meteo（免费，不用 key）
    let weather = null; // { at, temp, code, hi, lo, rain, wind, place } 或 { error }
    let weatherBusy = false;
    const WCODE = (c) => (c === 0 ? ["sun", "clear"] : c <= 2 ? ["cloud-sun", "partly"] : c === 3 ? ["cloud", "cloudy"] : c <= 48 ? ["cloud-fog", "fog"] : c <= 57 ? ["cloud-drizzle", "drizzle"] : c <= 67 ? ["cloud-rain", "rain"] : c <= 77 ? ["snowflake", "snow"] : c <= 82 ? ["cloud-rain", "rain"] : c <= 86 ? ["snowflake", "snow"] : ["cloud-lightning", "storm"]);
    function weatherInner(size) {
      const tw = (k, v) => t("widgets.weather." + k, v);
      if (!weather) return `<div class="flex h-full items-center justify-center text-sm text-slate-500">${esc(tw("loading"))}</div>`;
      if (weather.error)
        return `<div class="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-slate-500">${icon("map-pin-off", "size-6")}<span>${esc(tw(weather.error))}</span><button type="button" data-weather-retry class="no-drag rounded-full bg-slate-900 px-3 py-1 text-xs font-semibold text-white dark:bg-white dark:text-slate-900">${esc(tw("retry"))}</button></div>`;
      const [ic, key] = WCODE(weather.code);
      return `<div class="flex h-full flex-col justify-between">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0"><div class="flex items-center gap-1 truncate text-xs font-semibold text-slate-500 uppercase">${icon("map-pin", "size-3.5 shrink-0")}<span class="truncate">${esc(weather.place || tw("yourLocation"))}</span></div>
            <div class="mt-1 text-4xl font-bold tabular-nums">${Math.round(weather.temp)}°</div></div>
          ${icon(ic, size === "small" ? "size-10 text-sky-500" : "size-14 text-sky-500")}
        </div>
        <div>
          <div class="text-sm font-medium">${esc(tw(key))}</div>
          <div class="mt-0.5 text-xs text-slate-500">${esc(tw("high"))} ${Math.round(weather.hi)}° · ${esc(tw("low"))} ${Math.round(weather.lo)}°${size === "small" ? "" : ` · ${esc(tw("rainChance"))} ${weather.rain ?? 0}%`}</div>
        </div>
      </div>`;
    }
    async function loadWeather(force) {
      if (weatherBusy || (weather && !weather.error && !force && Date.now() - weather.at < 30 * 60e3)) return;
      weatherBusy = true;
      try {
        let geo = null;
        try {
          const saved = JSON.parse(localStorage.getItem("gw_geo") || "null");
          if (saved && !force && Date.now() - saved.at < 6 * 3600e3) geo = saved;
        } catch (e) {
          /* 忽略 */
        }
        if (!geo) {
          geo = await new Promise((resolve) => {
            if (!navigator.geolocation) return resolve(null);
            navigator.geolocation.getCurrentPosition((p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, at: Date.now() }), () => resolve(null), { timeout: 10000, maximumAge: 3600e3 });
          });
          if (geo)
            try {
              localStorage.setItem("gw_geo", JSON.stringify(geo));
            } catch (e) {
              /* 忽略 */
            }
        }
        if (!geo) weather = { error: "needLocation" };
        else {
          const url = `https://api.open-meteo.com/v1/forecast?latitude=${geo.lat}&longitude=${geo.lon}&current=temperature_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=1`;
          const j = await (await fetch(url)).json();
          let place = "";
          try {
            const g = await (await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${geo.lat}&longitude=${geo.lon}&localityLanguage=en`)).json();
            place = g.locality || g.city || g.principalSubdivision || "";
          } catch (e) {
            /* 名字取不到就算了 */
          }
          weather = { at: Date.now(), temp: j.current.temperature_2m, code: j.current.weather_code, wind: j.current.wind_speed_10m, hi: j.daily.temperature_2m_max[0], lo: j.daily.temperature_2m_min[0], rain: j.daily.precipitation_probability_max[0], place };
        }
      } catch (e) {
        weather = { error: "failed" };
      }
      weatherBusy = false;
      $$("[data-weather]", root).forEach((el) => (el.innerHTML = weatherInner(el.dataset.weather)));
      refreshIcons();
    }

    // Notice Board 的高度不能小过里面的内容
    function boardMinHeight() {
      const el = $(".gw-pinned", root);
      const ul = el && $("ul", el);
      if (!ul) return 150;
      const kids = [...ul.children];
      const content = kids.reduce((a, k) => a + k.offsetHeight, 0) + Math.max(0, kids.length - 1) * 8;
      return Math.max(150, Math.ceil(content + 72));
    }
    function fitBoard() {
      const w = board();
      const el = $(".gw-pinned", root);
      if (!el || !(w && w.config && Number(w.config.height) > 0)) return;
      const min = boardMinHeight();
      if (el.getBoundingClientRect().height < min - 1) el.style.height = min + "px";
    }

    // 往大一级 / 小一级：只看标题 ⇄ 第一行 ⇄ 全部
    async function stepBox(key, dir) {
      const i = MODES.indexOf(modeOf(key)) + (dir === "more" ? 1 : -1);
      if (i < 0 || i > 2) return;
      const mode = MODES[i];
      expanded.set(key, mode === "full");
      setLayout(key, { mode });
      draw();
      await Promise.all([saveLayout(key, { mode }), sb.from("gw_user_sections").upsert({ user_id: data.profile.id, group_id: key, expanded: mode === "full" })]);
    }

    // 文件夹名称 / 便条内容
    function itemDialog(item, gid, kind, order) {
      const isNote = kind === "note";
      const dlg = modal(
        item ? t(isNote ? "home.editNote" : "home.editFolder") : t(isNote ? "home.newNote" : "home.newFolder"),
        `<form class="space-y-4">
          <input name="name" maxlength="40" ${isNote ? "" : "required"} value="${esc(item ? item.name || "" : "")}" placeholder="${esc(t(isNote ? "home.noteTitle" : "home.folderName"))}" class="${cls.input}">
          ${isNote ? `<textarea name="body" rows="6" maxlength="2000" placeholder="${esc(t("home.noteBody"))}" class="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500 dark:border-slate-700 dark:bg-slate-900">${esc(item ? item.body || "" : "")}</textarea>` : ""}
          <div class="flex justify-between gap-2">
            ${item ? `<button type="button" data-del class="${btn("ghost")} text-red-600 dark:text-red-400">${icon("trash-2", "size-4")} ${esc(t("home.delete"))}</button>` : "<span></span>"}
            <div class="flex gap-2"><button type="button" data-cancel class="${btn("secondary")}">${esc(t("home.cancel"))}</button><button type="submit" class="${btn("primary")}">${esc(t("home.save"))}</button></div>
          </div>
        </form>`,
      );
      refreshIcons();
      $("[data-cancel]", dlg.el).onclick = dlg.close;
      $("[name=name]", dlg.el).focus();
      if (item)
        $("[data-del]", dlg.el).onclick = async () => {
          if (!isNote) {
            if (!(await confirmDialog(t("home.deleteFolderTitle"), t("home.deleteFolderBody", { name: item.name }), t("home.delete"), t("home.cancel")))) return;
            // 文件夹里的 App 回到区块里
            sItems.filter((x) => x.parent_id === item.id).forEach((x) => (x.parent_id = null));
            await sb.from("gw_user_section_items").update({ parent_id: null }).eq("parent_id", item.id);
          }
          sItems = sItems.filter((x) => x.id !== item.id);
          dlg.close();
          drawSections();
          const { error } = await sb.from("gw_user_section_items").delete().eq("id", item.id);
          if (error) toast(t("home.saveFailed"));
        };
      $("form", dlg.el).addEventListener("submit", async (e) => {
        e.preventDefault();
        const f = e.target;
        const fields = { name: f.name.value.trim() || null, body: isNote ? f.body.value : null };
        if (item) {
          const { error } = await sb.from("gw_user_section_items").update(fields).eq("id", item.id);
          if (error) return toast(t("home.saveFailed"));
          Object.assign(item, fields);
        } else {
          const { data: created, error } = await sb.from("gw_user_section_items").insert({ ...fields, user_id: data.profile.id, group_id: gid, kind, sort_order: order }).select().single();
          if (error) return toast(t("home.saveFailed"));
          sItems.push(created);
        }
        dlg.close();
        drawSections();
      });
    }

    // 文件夹：放大成浮动窗，名字在上面；可以加 App 进来、拿出去、改名、删除
    function openBoxFolder(fid) {
      const f = sItems.find((x) => x.id === fid);
      if (!f) return;
      const kids = folderKids(fid);
      const wrap = document.createElement("div");
      wrap.setAttribute("role", "dialog");
      wrap.className = "fixed inset-0 z-50 flex flex-col items-center justify-center bg-slate-900/40 p-6 backdrop-blur-md";
      wrap.innerHTML = `
        <h2 class="mb-5 max-w-full truncate px-4 text-3xl font-bold text-white drop-shadow sm:text-4xl">${esc(f.name || "")}</h2>
        <div data-win class="w-full max-w-md rounded-[2rem] border border-white/60 bg-white/75 p-6 shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-slate-900/75">
          ${
            kids.length
              ? `<div class="grid grid-cols-3 gap-5 sm:grid-cols-4">${kids
                  .map(
                    (k) => `<div class="relative flex flex-col items-center gap-1.5">
                      <button type="button" data-open="${k.module_id}" class="flex flex-col items-center gap-1.5">${appIcon(modules.get(k.module_id), "size-14 sm:size-16")}<span class="w-20 truncate text-center text-xs font-medium text-slate-700 dark:text-slate-200">${esc(modules.get(k.module_id).name)}</span></button>
                      <button type="button" data-out="${k.id}" title="${esc(t("fab.moveOut"))}" aria-label="${esc(t("fab.moveOut"))}" class="absolute -top-1 right-1 flex size-6 items-center justify-center rounded-full bg-slate-700/90 text-white shadow ring-2 ring-white dark:ring-slate-900">${icon("arrow-up-right", "size-3.5")}</button>
                    </div>`,
                  )
                  .join("")}</div>`
              : `<p class="py-6 text-center text-sm text-slate-500">${esc(t("fab.emptyFolder"))}</p>`
          }
        </div>
        <div class="mt-4 flex gap-2">
          <button type="button" data-fadd class="inline-flex items-center gap-1.5 rounded-full bg-white/80 px-4 py-2 text-sm font-medium text-slate-700 shadow backdrop-blur dark:bg-slate-800/80 dark:text-slate-200">${icon("plus", "size-4")} ${esc(t("home.addApps"))}</button>
          <button type="button" data-frename class="inline-flex items-center gap-1.5 rounded-full bg-white/80 px-4 py-2 text-sm font-medium text-slate-700 shadow backdrop-blur dark:bg-slate-800/80 dark:text-slate-200">${icon("pencil", "size-4")} ${esc(t("home.editFolder"))}</button>
        </div>`;
      document.body.appendChild(wrap);
      refreshIcons();
      const close = () => wrap.remove();
      const onKey = (e) => e.key === "Escape" && (close(), document.removeEventListener("keydown", onKey));
      document.addEventListener("keydown", onKey);
      wrap.addEventListener("click", async (e) => {
        const b = e.target.closest("button");
        if (!b) {
          if (!e.target.closest("[data-win]")) close();
          return;
        }
        if (b.dataset.open) return close(), open(b.dataset.open);
        if (b.dataset.out) {
          const it = sItems.find((x) => x.id === b.dataset.out);
          it.parent_id = null;
          it.sort_order = Math.max(-1, ...sItems.filter((x) => x.group_id === f.group_id && !x.parent_id).map((x) => x.sort_order)) + 1;
          close();
          drawSections();
          await sb.from("gw_user_section_items").update({ parent_id: null, sort_order: it.sort_order }).eq("id", it.id);
          return openBoxFolder(fid);
        }
        if ("frename" in b.dataset) return close(), itemDialog(f, f.group_id, "folder");
        if ("fadd" in b.dataset) return close(), folderAddDialog(f);
      });
    }
    // 把区块里还没放进文件夹的 App 勾选放进来
    function folderAddDialog(f) {
      const loose = boxItems(f.group_id).filter((x) => x.kind === "module");
      const dlg = modal(
        t("home.addApps"),
        loose.length
          ? `<form class="space-y-4"><div class="space-y-1.5">${loose.map((x) => `<label class="flex items-center gap-3 rounded-xl border border-slate-200 px-3 py-2 text-sm dark:border-slate-800"><input type="checkbox" name="pick" value="${x.id}" class="size-4 accent-emerald-600">${appIcon(modules.get(x.module_id), "size-8")}<span class="truncate">${esc(modules.get(x.module_id).name)}</span></label>`).join("")}</div>
            <div class="flex justify-end gap-2"><button type="button" data-cancel class="${btn("secondary")}">${esc(t("home.cancel"))}</button><button type="submit" class="${btn("primary")}">${esc(t("home.save"))}</button></div></form>`
          : `<p class="text-sm text-slate-500">${esc(t("home.noLooseApps"))}</p>`,
      );
      refreshIcons();
      const cancel = $("[data-cancel]", dlg.el);
      if (cancel) cancel.onclick = dlg.close;
      const form = $("form", dlg.el);
      if (form)
        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          const picked = $$("[name=pick]:checked", form).map((x) => x.value);
          dlg.close();
          let n = folderKids(f.id).length;
          const rows = [];
          for (const key of picked) {
            if (key.startsWith("new:")) rows.push({ user_id: data.profile.id, group_id: f.group_id, kind: "module", module_id: key.slice(4), parent_id: f.id, sort_order: n++ });
            else {
              const it = sItems.find((x) => x.id === key);
              it.parent_id = f.id;
              it.sort_order = n++;
              await sb.from("gw_user_section_items").update({ parent_id: f.id, sort_order: it.sort_order }).eq("id", it.id);
            }
          }
          if (rows.length) {
            const { data: created, error } = await sb.from("gw_user_section_items").insert(rows).select();
            if (error) toast(t("home.saveFailed"));
            else sItems.push(...created);
          }
          drawSections();
          openBoxFolder(f.id);
        });
    }

    function draw() {
      clearInterval(clockTimer);
      // 还没被分配到任何群组：主画面什么都不显示，只显示等待分配
      if (opts && opts.pending) {
        root.innerHTML = `<div class="mx-auto mt-[12vh] max-w-md rounded-3xl border border-white/70 bg-white/80 p-8 text-center shadow-lg backdrop-blur dark:border-white/10 dark:bg-slate-900/70">
          <span class="mx-auto mb-4 flex size-14 items-center justify-center rounded-full bg-amber-100 text-amber-600 dark:bg-amber-900/40 dark:text-amber-300">${icon("hourglass", "size-7")}</span>
          <h2 class="text-lg font-semibold">${esc(t("home.pendingTitle"))}</h2>
          <p class="mt-2 text-sm text-slate-500">${esc(t("home.pendingBody"))}</p>
          <p class="mt-4 text-xs text-slate-400">${esc(profile.email)}</p>
        </div>`;
        return refreshIcons();
      }
      const P = positions();
      const items = rootItems();
      // 棋盘下面多留两行空位，可以把东西拖到更下面
      const rows = rowsUsed(P) + (readOnly ? 0 : 2);
      const tile = (it) => {
        const p = P.pos.get(it.kind + ":" + it.id);
        const at = `style="grid-column:${p.c + 1} / span ${p.w};grid-row:${p.r + 1} / span ${p.h}"`;
        if (it.kind === "app") return appTile(it.id).replace('class="gw-item', at + ' class="gw-item');
        if (it.kind === "folder") return folderTile(folders.find((f) => f.id === it.id)).replace('class="gw-item', at + ' class="gw-item');
        if (it.kind === "link") return linkTile(links.find((l) => l.id === it.id)).replace('class="gw-item', at + ' class="gw-item');
        return widgetTile(widgets.find((w) => w.id === it.id), p);
      };
      // 区块版：Notice Board 下面是各 Business 区块和「My Home」（自由摆放：App、小工具、文件夹、连结），顺序可以拖拉调整
      const showGrid = !sectionsOn || items.length > 0 || editing || !!sheet;
      const gridHtml = showGrid
        ? `<div id="gw-grid" data-cols="${P.n}" class="${editing ? "gw-editing" : ""} relative grid gap-x-2 gap-y-4 [grid-auto-rows:5.25rem] sm:[grid-auto-rows:5.75rem]"
             style="grid-template-columns:repeat(${P.n},minmax(0,1fr));grid-template-rows:repeat(${Math.max(rows, 1)},var(--gw-row,5.25rem))">
          ${items.map(tile).join("")}
          <div data-drop-hint class="pointer-events-none hidden rounded-2xl border-2 border-dashed"></div>
        </div>`
        : "";
      let stackHtml = "";
      if (sectionsOn) {
        const parts = [];
        S.groups.forEach((g) => {
          const mods = modsOfGroup(g.id);
          if (!(mods.length || sItems.some((x) => x.group_id === g.id))) return;
          const P = boxPositions(g.id);
          const tiles = P.items.map((it) => sTile(it, P.pos.get(it.id))).join("");
          parts.push([g.id, boxShell({ key: g.id, title: g.name, mode: modeOf(g.id), tiles, n: P.n, rows: P.rows, widgetsHtml: modeOf(g.id) === "title" ? "" : floatsIn(g.id) })]);
        });
        if (showGrid) {
          const lay = secLayout("home");
          parts.push([
            "home",
            `<div data-sec-wrap data-sec-key="home" class="p-2" style="width:${Math.round(lay.w * 100)}%"><section class="${glass} h-auto! overflow-visible! pb-6"><div class="mb-3 flex items-center gap-1.5">${secGrip()}<h2 class="truncate text-base font-bold text-slate-800 dark:text-slate-100">${esc(t("home.myHome"))}</h2></div><div data-fw-host="home" class="relative" style="${lay.h ? `min-height:${lay.h}px` : ""}">${gridHtml}${floatsIn("home")}</div>${resizeGrip("home")}</section></div>`,
          ]);
        }
        const order = sectionOrder();
        const rank = (k) => (order.indexOf(k) === -1 ? 999 : order.indexOf(k));
        parts.sort((a, b) => rank(a[0]) - rank(b[0]));
        stackHtml = `<div id="gw-stack" class="-mx-2 mb-6 flex flex-wrap items-start">${parts.map((x) => x[1]).join("")}</div><div id="gw-float" class="pointer-events-none absolute inset-0 z-40 [&>*]:pointer-events-auto">${floatsIn(null)}</div>`;
      }
      root.innerHTML = `
        ${uninitialized ? `<div class="mb-4 rounded-2xl bg-white/70 px-3 py-2 text-sm text-slate-600 dark:bg-slate-900/60 dark:text-slate-300">${esc(t("home.previewUninitialized"))}</div>` : ""}
        ${boardHtml()}
        ${stackHtml}
        ${editing ? `<p class="mb-3 text-center text-xs text-slate-500">${esc(t("fab.editHint"))}</p>` : ""}
        ${sectionsOn ? "" : gridHtml}
        ${items.length === 0 && !sectionsOn ? `<div class="${cls.empty} mt-2 bg-white/60 dark:bg-slate-900/40">${esc(data.modules.length ? t("fab.emptyHome") : t("home.noModules"))}</div>` : ""}
        ${
          sheet
            ? `<aside class="gw-sheet fixed inset-x-0 bottom-0 z-50 max-h-[62vh] overflow-y-auto rounded-t-3xl border border-white/60 bg-white/75 p-4 shadow-2xl backdrop-blur-2xl sm:inset-x-auto sm:top-20 sm:right-4 sm:bottom-4 sm:max-h-none sm:w-96 sm:rounded-3xl dark:border-white/10 dark:bg-slate-900/75">${sheet === "apps" ? appsSheet() : widgetsSheet()}</aside>`
            : ""
        }
        ${fabHtml()}`;
      refreshIcons();
      if (sectionsOn) {
        root.classList.add("relative");
        lastBoxCols = boxColsSig();
        afterSections();
        fitBoard();
      }
      if ($("[data-weather]", root)) loadWeather();
      aiAfterDraw();
      if ($("[data-clock]", root)) {
        clockTimer = setInterval(() => {
          const now = new Intl.DateTimeFormat(GW.LOCALE, { timeZone: GW_CONFIG.timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
          $$("[data-clock]", root).forEach((el) => (el.textContent = now));
        }, 1000);
      }
    }
    // 栏数随视窗宽度变（手机 4、平板 6、电脑 8）
    let lastCols = cols();
    addEventListener("resize", () => {
      if (cols() !== lastCols) ((lastCols = cols()), draw());
    });

    // ------------------------------------------------------------ 拖拉（像 iPhone：长按拿起，放到任何空格；格子会对齐）
    /* 规则：放到空格 → 移过去；App 放到文件夹上 → 收进文件夹；
             1×1 的东西放到另一个 1×1 上 → 两个交换；小工具要整块空位才放得下。
       从「Add Apps」面板也可以直接拖到想放的格子。 */
    let drag = null;
    const cellOf = (grid, x, y) => {
      const rect = grid.getBoundingClientRect();
      const cs = getComputedStyle(grid);
      const n = Number(grid.dataset.cols);
      const gx = parseFloat(cs.columnGap) || 0, gy = parseFloat(cs.rowGap) || 0;
      const rowH = parseFloat(cs.gridTemplateRows.split(" ")[0]) || 84;
      const cellW = (rect.width - gx * (n - 1)) / n;
      const rows = cs.gridTemplateRows.split(" ").length;
      return {
        c: Math.max(0, Math.min(n - 1, Math.floor((x - rect.left) / (cellW + gx)))),
        r: Math.max(0, Math.min(rows - 1, Math.floor((y - rect.top) / (rowH + gy)))),
        n, rows, cellW, rowH, gx, gy, rect,
      };
    };
    function dragTarget(e) {
      const grid = $("#gw-grid", root);
      const g = cellOf(grid, e.clientX, e.clientY);
      let c = Math.max(0, Math.min(g.n - drag.w, g.c - drag.offC));
      let r = Math.max(0, g.r - drag.offR);
      const P = positions(drag.kind === "lib" ? null : { kind: drag.kind, id: drag.id });
      // 这个位置上有什么
      const hits = new Set();
      P.pos.forEach((p, key) => {
        if (c < p.c + p.w && c + drag.w > p.c && r < p.r + p.h && r + drag.h > p.r) hits.add(key);
      });
      let action = null;
      if (!hits.size) action = { type: "place", slot: r * g.n + c };
      else if (hits.size === 1) {
        const key = [...hits][0];
        const [kind, id] = key.split(":");
        const p = P.pos.get(key);
        if (kind === "folder" && (drag.kind === "app" || drag.kind === "lib" || drag.kind === "link")) action = { type: "folder", fid: id };
        else if (drag.w === 1 && drag.h === 1 && p.w === 1 && p.h === 1 && drag.kind !== "lib") action = { type: "swap", kind, id, theirSlot: p.slot, mySlot: drag.slot };
      }
      return { c, r, g, action };
    }
    function showHint(tg) {
      const hint = $("[data-drop-hint]", root);
      if (!hint) return;
      hint.classList.remove("hidden");
      hint.className = `pointer-events-none rounded-2xl border-2 border-dashed ${tg.action ? "border-brand-500/70 bg-brand-500/10" : "border-rose-400/70 bg-rose-400/10"}`;
      hint.style.gridColumn = `${tg.c + 1} / span ${drag.w}`;
      hint.style.gridRow = `${tg.r + 1} / span ${drag.h}`;
    }
    function startDrag(e, el) {
      const lib = el.dataset.lib;
      const rect = el.getBoundingClientRect();
      const grid = $("#gw-grid", root);
      const g = cellOf(grid, rect.left, rect.top);
      let w = 1, h = 1;
      if (el.dataset.kind === "widget") [w, h] = SIZES[widgets.find((x) => x.id === el.dataset.id).size];
      const cur = lib ? null : positions().pos.get(el.dataset.kind + ":" + el.dataset.id);
      drag = {
        kind: lib ? "lib" : el.dataset.kind,
        id: lib || el.dataset.id,
        slot: cur ? cur.slot : null,
        el, w, h,
        // 手指抓在东西的第几格（宽的小工具才有差）
        offC: lib ? 0 : Math.min(w - 1, Math.floor((e.clientX - rect.left) / (g.cellW + g.gx))),
        offR: lib ? 0 : Math.min(h - 1, Math.floor((e.clientY - rect.top) / (g.rowH + g.gy))),
        dx: e.clientX - rect.left,
        dy: e.clientY - rect.top,
        target: null,
      };
      const ghost = el.cloneNode(true);
      ghost.removeAttribute("data-kind");
      ghost.style.cssText = `position:fixed;left:0;top:0;width:${rect.width}px;height:${rect.height}px;z-index:60;pointer-events:none;transform:translate(${rect.left}px,${rect.top}px) scale(1.08);opacity:.95;transition:none;margin:0`;
      ghost.className = ghost.className.replace("gw-item", "gw-ghost");
      document.body.appendChild(ghost);
      drag.ghost = ghost;
      el.classList.add("opacity-30");
      document.body.classList.add("gw-dragging");
      if (sheet) $(".gw-sheet", root).classList.add("opacity-40", "pointer-events-none");
    }
    function moveDrag(e) {
      drag.ghost.style.transform = `translate(${e.clientX - drag.dx}px,${e.clientY - drag.dy}px) scale(1.08)`;
      // 靠近上下边缘时自动卷动
      if (e.clientY < 90) scrollBy(0, -14);
      else if (e.clientY > innerHeight - 90) scrollBy(0, 14);
      drag.target = dragTarget(e);
      showHint(drag.target);
    }
    async function endDrag(cancelled) {
      const d = drag;
      drag = null;
      d.ghost.remove();
      d.el.classList.remove("opacity-30");
      document.body.classList.remove("gw-dragging");
      lastDragEnd = Date.now();
      const a = !cancelled && d.target && d.target.action;
      if (!a) return draw();
      if (d.kind === "lib") {
        if (a.type === "folder") {
          if (layout.has(d.id)) return draw();
          layout.set(d.id, { folder_id: a.fid, sort_order: folderApps(a.fid).length + 1 });
          draw();
          await saveApps([{ module_id: d.id, folder_id: a.fid, sort_order: layout.get(d.id).sort_order }]);
          sb.rpc("gw_mark_seen", { p_modules: [d.id] });
          return toast(t("home.added"));
        }
        return addApp(d.id, a.slot);
      }
      if (a.type === "place") {
        const saving = saveSlot(d.kind, d.id, a.slot); // 先改记忆中的位置再重画
        draw();
        return saving;
      }
      if (a.type === "folder") return d.kind === "link" ? moveLinkToFolder(d.id, a.fid) : moveIntoFolder(d.id, a.fid);
      if (a.type === "swap") {
        const saving = Promise.all([saveSlot(d.kind, d.id, a.theirSlot), saveSlot(a.kind, a.id, a.mySlot)]);
        draw();
        return saving;
      }
      draw();
    }
    // Notice Board 下缘：按住往上 / 往下拖调高度，放开时记住
    root.addEventListener("pointerdown", (e) => {
      const grab = e.target.closest("[data-board-resize]");
      if (!grab || e.button !== 0) return;
      const el = grab.closest(".gw-pinned");
      const startY = e.clientY;
      const startH = el.getBoundingClientRect().height;
      let h = startH;
      e.preventDefault();
      document.body.classList.add("gw-dragging");
      const move = (ev) => {
        h = Math.max(boardMinHeight(), Math.min(Math.max(720, boardMinHeight()), startH + ev.clientY - startY));
        el.style.height = h + "px";
        el.classList.remove("h-[13rem]", "h-[22rem]");
      };
      const up = async () => {
        removeEventListener("pointermove", move);
        removeEventListener("pointerup", up);
        removeEventListener("pointercancel", up);
        document.body.classList.remove("gw-dragging");
        lastDragEnd = Date.now();
        const w = board();
        if (!w) return;
        w.config = { ...(w.config || {}), height: Math.round(h) };
        const { error } = await sb.from("gw_user_widgets").update({ config: w.config }).eq("id", w.id);
        if (error) toast(t("home.saveFailed"));
      };
      addEventListener("pointermove", move);
      addEventListener("pointerup", up);
      addEventListener("pointercancel", up);
    });
    // 长按（手机）或拖动（滑鼠）开始
    let press = null;
    root.addEventListener("pointerdown", (e) => {
      if (readOnly || drag || e.button !== 0) return;
      const el = e.target.closest("#gw-grid > .gw-item, .gw-sheet-apps [data-lib]:not(.gw-added)");
      if (!el || e.target.closest(".no-drag")) return;
      const touch = e.pointerType !== "mouse";
      press = { el, x: e.clientX, y: e.clientY, id: e.pointerId, touch };
      if (touch) press.timer = setTimeout(() => press && ((press.hold = true), startDrag(e, el), moveDrag(e)), 280);
    });
    root.addEventListener("pointermove", (e) => {
      if (drag) return moveDrag(e);
      if (!press || e.pointerId !== press.id) return;
      const far = Math.hypot(e.clientX - press.x, e.clientY - press.y) > 8;
      if (press.touch && far) ((clearTimeout(press.timer)), (press = null)); // 手指在滑动页面，不是要拖
      else if (!press.touch && far) ((startDrag(e, press.el)), moveDrag(e), (press = null));
    });
    const up = (e) => {
      if (press) ((clearTimeout(press.timer)), (press = null));
      if (drag) endDrag(e.type === "pointercancel");
    };
    root.addEventListener("pointerup", up);
    root.addEventListener("pointercancel", up);
    addEventListener("pointerup", (e) => drag && up(e));
    // 拖拉中不让页面跟着手指卷动；长按不要跳出系统选单
    document.addEventListener("touchmove", (e) => drag && e.preventDefault(), { passive: false });
    root.addEventListener("contextmenu", (e) => (drag || press) && e.preventDefault());

    // ------------------------------------------------------------ App 选单 / 文件夹
    // 个人连结图示：名称、网址、图示
    function linkDialog(link) {
      let chosen = link ? link.icon : "link";
      const dlg = modal(
        link ? t("home.editLink") : t("fab.addLink"),
        `<form class="space-y-4">
          <div data-err></div>
          <label class="block space-y-1.5"><span class="${cls.label}">${esc(t("home.linkName"))}</span><input name="name" required maxlength="40" value="${esc(link ? link.name : "")}" class="${cls.input}"></label>
          <label class="block space-y-1.5"><span class="${cls.label}">${esc(t("home.linkUrl"))}</span><input name="url" type="url" required value="${esc(link ? link.url : "https://")}" class="${cls.input}"></label>
          <div>
            <p class="mb-1.5 ${cls.label}">${esc(t("home.linkIcon"))}</p>
            <div class="flex flex-wrap gap-1.5">${["link", ...Object.keys(GW.MODULE_ICONS)].filter((v, i, a) => a.indexOf(v) === i).map((k) => `<button type="button" data-pick-icon="${k}" class="flex size-9 items-center justify-center rounded-lg border"></button>`).join("")}</div>
          </div>
          <div class="flex justify-end gap-2">
            <button type="button" data-cancel class="${btn("secondary")}">${esc(t("home.cancel"))}</button>
            <button type="submit" class="${btn("primary")}">${esc(t("home.save"))}</button>
          </div>
        </form>`,
      );
      const paint = () =>
        $$("[data-pick-icon]", dlg.el).forEach((b) => {
          b.className = `flex size-9 items-center justify-center rounded-lg border ${b.dataset.pickIcon === chosen ? "border-brand-500 bg-brand-50 text-brand-600 dark:bg-brand-700/20 dark:text-brand-100" : "border-slate-200 text-slate-500 dark:border-slate-700"}`;
          b.innerHTML = b.dataset.pickIcon === "link" ? icon("link", "size-4") : moduleIcon(b.dataset.pickIcon, "size-4");
        });
      paint();
      refreshIcons();
      $$("[data-pick-icon]", dlg.el).forEach((b) => b.addEventListener("click", () => ((chosen = b.dataset.pickIcon), paint(), refreshIcons())));
      $("[data-cancel]", dlg.el).onclick = dlg.close;
      $("form", dlg.el).addEventListener("submit", async (e) => {
        e.preventDefault();
        const f = e.target;
        const row = { name: f.name.value.trim(), url: f.url.value.trim(), icon: chosen };
        if (!/^https?:\/\//i.test(row.url)) return ($("[data-err]", dlg.el).innerHTML = GW.alertBox(t("home.badUrl")));
        if (link) {
          const { error } = await sb.from("gw_user_links").update(row).eq("id", link.id);
          if (error) return ($("[data-err]", dlg.el).innerHTML = GW.alertBox(t("home.saveFailed")));
          Object.assign(link, row);
        } else {
          const { data: created, error } = await sb
            .from("gw_user_links")
            .insert({ ...row, user_id: data.profile.id, sort_order: nextSlot(1, 1) })
            .select()
            .single();
          if (error) return ($("[data-err]", dlg.el).innerHTML = GW.alertBox(t("home.saveFailed")));
          links.push(created);
        }
        dlg.close();
        draw();
      });
    }

    async function removeLink(id) {
      links = links.filter((l) => l.id !== id);
      draw();
      await sb.from("gw_user_links").delete().eq("id", id);
    }

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
        const order = folderId ? folderApps(folderId).length + 1 : nextSlot(1, 1);
        layout.set(id, { folder_id: folderId, sort_order: order });
        dlg.close();
        draw();
        await saveApps([{ module_id: id, folder_id: folderId, sort_order: order }]);
      });
      $("[data-remove]", dlg.el).onclick = () => (dlg.close(), removeApp(id));
    }

    // 文件夹：像 iPhone 一样放大成一个浮动窗，名字在上面
    function openFolder(fid) {
      const f = folders.find((x) => x.id === fid);
      const ids = folderApps(fid);
      const lks = folderLinks(fid);
      const wrap = document.createElement("div");
      wrap.setAttribute("role", "dialog");
      wrap.className = "fixed inset-0 z-50 flex flex-col items-center justify-center bg-slate-900/40 p-6 backdrop-blur-md";
      wrap.innerHTML = `
        <h2 class="mb-5 max-w-full truncate px-4 text-3xl font-bold text-white drop-shadow sm:text-4xl">${esc(f.name)}</h2>
        <div data-win class="w-full max-w-md rounded-[2rem] border border-white/60 bg-white/75 p-6 shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-slate-900/75">
          ${
            ids.length || lks.length
              ? `<div class="grid grid-cols-3 gap-5 sm:grid-cols-4">${ids
                  .map(
                    (id) => `<div class="relative flex flex-col items-center gap-1.5">
                      <button type="button" data-open="${id}" class="flex flex-col items-center gap-1.5">${appIcon(modules.get(id), "size-14 sm:size-16")}<span class="w-20 truncate text-center text-xs font-medium text-slate-700 dark:text-slate-200">${esc(modules.get(id).name)}</span></button>
                      ${readOnly ? "" : `<button type="button" data-out="${id}" title="${esc(t("fab.moveOut"))}" aria-label="${esc(t("fab.moveOut"))}" class="absolute -top-1 right-1 flex size-6 items-center justify-center rounded-full bg-slate-700/90 text-white shadow ring-2 ring-white dark:ring-slate-900">${icon("arrow-up-right", "size-3.5")}</button>`}
                    </div>`,
                  )
                  .join("")}${lks
                  .map(
                    (l) => `<div class="relative flex flex-col items-center gap-1.5">
                      <button type="button" data-open-link="${l.id}" title="${esc(l.url)}" class="flex flex-col items-center gap-1.5">${appIcon({ code: l.name, icon: l.icon, image_url: l.image_url }, "size-14 sm:size-16")}<span class="w-20 truncate text-center text-xs font-medium text-slate-700 dark:text-slate-200">${esc(l.name)}</span></button>
                      ${readOnly ? "" : `<button type="button" data-out-link="${l.id}" title="${esc(t("fab.moveOut"))}" aria-label="${esc(t("fab.moveOut"))}" class="absolute -top-1 right-1 flex size-6 items-center justify-center rounded-full bg-slate-700/90 text-white shadow ring-2 ring-white dark:ring-slate-900">${icon("arrow-up-right", "size-3.5")}</button>`}
                    </div>`,
                  )
                  .join("")}</div>`
              : `<p class="py-6 text-center text-sm text-slate-500">${esc(t("fab.emptyFolder"))}</p>`
          }
        </div>
        ${readOnly ? "" : `<button type="button" data-rename class="mt-4 inline-flex items-center gap-1.5 rounded-full bg-white/80 px-4 py-2 text-sm font-medium text-slate-700 shadow backdrop-blur dark:bg-slate-800/80 dark:text-slate-200">${icon("pencil", "size-4")} ${esc(t("home.editFolder"))}</button>`}`;
      document.body.appendChild(wrap);
      refreshIcons();
      const close = () => wrap.remove();
      const onKey = (e) => e.key === "Escape" && (close(), document.removeEventListener("keydown", onKey));
      document.addEventListener("keydown", onKey);
      wrap.addEventListener("click", async (e) => {
        const b = e.target.closest("button");
        if (!b) {
          if (!e.target.closest("[data-win]")) close();
          return;
        }
        if (b.dataset.open) return close(), open(b.dataset.open);
        if (b.dataset.openLink) {
          const l = links.find((x) => x.id === b.dataset.openLink);
          return l && window.open(l.url, "_blank", "noopener,noreferrer");
        }
        if (b.dataset.outLink) {
          close();
          await moveLinkToFolder(b.dataset.outLink, null);
          return openFolder(fid);
        }
        if (b.dataset.out) {
          const id = b.dataset.out;
          const slot = nextSlot(1, 1);
          layout.set(id, { folder_id: null, sort_order: slot });
          close();
          draw();
          await saveApps([{ module_id: id, folder_id: null, sort_order: slot }]);
          return openFolder(fid);
        }
        if ("rename" in b.dataset) {
          close();
          folderDialog(f);
        }
      });
    }

    // 图示颜色：全部一起选（柔和 / 多彩 / 单一颜色），也可以一个一个 App 自己选
    async function saveIcons() {
      const w = board();
      if (!w) return;
      w.config = { ...(w.config || {}), icons: { style: ICON.style, apps: ICON.apps } };
      const { error } = await sb.from("gw_user_widgets").update({ config: w.config }).eq("id", w.id);
      if (error) toast(t("home.saveFailed"));
    }
    function iconColorsDialog() {
      const swatch = (key, on, attr, label) =>
        `<button type="button" ${attr} aria-label="${esc(label)}" title="${esc(label)}" class="size-8 shrink-0 rounded-full border-2 ${on ? "border-slate-900 dark:border-white" : "border-white dark:border-slate-700"} shadow" style="background:${PALETTE[key][1]}"></button>`;
      const styleBtn = (key, label, on) => `<button type="button" data-ic-style="${key}" class="rounded-full border px-3 py-1.5 text-sm font-medium ${on ? "border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-700/20 dark:text-brand-100" : "border-slate-300 text-slate-600 dark:border-slate-700 dark:text-slate-300"}">${esc(label)}</button>`;
      const dlg = modal(t("fab.iconColors"), "", { wide: true });
      const draw2 = () => {
        dlg.el.innerHTML = `<div class="space-y-5">
          <div>
            <p class="mb-2 ${cls.label}">${esc(t("home.iconAll"))}</p>
            <div class="flex flex-wrap items-center gap-2">
              ${styleBtn("calm", t("home.iconCalm"), ICON.style === "calm")}${styleBtn("colorful", t("home.iconColorful"), ICON.style === "colorful")}
              <span class="mx-1 h-6 w-px bg-slate-200 dark:bg-slate-700"></span>
              ${Object.keys(PALETTE).map((k) => swatch(k, ICON.style === k, `data-ic-style="${k}"`, t("home.color." + k))).join("")}
            </div>
          </div>
          <div>
            <p class="mb-2 ${cls.label}">${esc(t("home.iconEach"))}</p>
            <div class="max-h-[40vh] space-y-2 overflow-y-auto pr-1">
              ${data.modules
                .map(
                  (m) => `<div class="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 p-2.5 dark:border-slate-800">
                    ${appIcon(m, "size-10")}
                    <span class="min-w-0 flex-1 basis-28 truncate text-sm font-medium">${esc(m.name)}</span>
                    <span class="flex flex-wrap items-center gap-1.5">
                      <button type="button" data-ic-app="${m.id}" data-color="" class="rounded-full border px-2 py-1 text-xs ${ICON.apps[m.id] ? "border-slate-300 text-slate-500 dark:border-slate-700" : "border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-700/20 dark:text-brand-100"}">${esc(t("home.iconAuto"))}</button>
                      ${Object.keys(PALETTE).map((k) => swatch(k, ICON.apps[m.id] === k, `data-ic-app="${m.id}" data-color="${k}"`, t("home.color." + k))).join("")}
                    </span>
                  </div>`,
                )
                .join("")}
            </div>
          </div>
          <div class="flex justify-end"><button type="button" data-done class="${btn("primary")}">${esc(t("home.save"))}</button></div>
        </div>`;
        refreshIcons();
      };
      draw2();
      dlg.el.addEventListener("click", async (e) => {
        const b = e.target.closest("button");
        if (!b) return;
        if ("done" in b.dataset) return dlg.close();
        if (b.dataset.icStyle) {
          ICON.style = b.dataset.icStyle;
          ICON.apps = {}; // 选了整体风格，个别设定清掉，从头开始
        } else if (b.dataset.icApp) {
          if (b.dataset.color) ICON.apps[b.dataset.icApp] = b.dataset.color;
          else delete ICON.apps[b.dataset.icApp];
        } else return;
        draw2();
        draw();
        saveIcons();
      });
    }

    // 在 Notice Board 直接发布 / 修改公告：super_admin 可发全公司或某个 Business；角色只能发给自己负责的 Business
    async function postNotice(notice) {
      const { data: groups } = await sb.from("gw_groups").select("id, name").order("sort_order").order("name");
      const targets = [
        ...(isSuper ? [["", t("widgets.postEveryone")]] : []),
        ...(groups || []).filter((g) => isSuper || bizCan(g.id, "can_post_notice")).map((g) => [g.id, g.name]),
      ];
      if (!targets.length) return toast(t("widgets.postFailed"));
      const cur = notice || { message: "", group_id: "", level: "info" };
      const dlg = modal(
        notice ? t("widgets.editNotice") : t("widgets.postTitle"),
        `<form class="space-y-4">
          <div data-err></div>
          <textarea name="message" required maxlength="500" rows="4" placeholder="${esc(t("widgets.postPlaceholder"))}" class="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500 dark:border-slate-700 dark:bg-slate-900">${esc(cur.message)}</textarea>
          <label class="block space-y-1.5"><span class="${cls.label}">${esc(t("widgets.postAudience"))}</span>
            <select name="group_id" class="${cls.input}">${targets.map(([v, l]) => `<option value="${esc(v)}" ${v === (cur.group_id || "") ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>
          </label>
          <label class="flex items-center gap-2 text-sm"><input type="checkbox" name="important" ${cur.level === "warning" ? "checked" : ""} class="size-4 accent-amber-500"> ${esc(t("widgets.postImportant"))}</label>
          <div class="flex justify-end gap-2">
            <button type="button" data-cancel class="${btn("secondary")}">${esc(t("settings.cancel"))}</button>
            <button type="submit" class="${btn("primary")}">${esc(notice ? t("widgets.save") : t("widgets.post"))}</button>
          </div>
        </form>`,
      );
      $("[data-cancel]", dlg.el).onclick = dlg.close;
      $("form", dlg.el).addEventListener("submit", async (e) => {
        e.preventDefault();
        const f = e.target;
        const groupId = f.group_id.value || null;
        const fields = { message: f.message.value.trim(), level: f.important.checked ? "warning" : "info", group_id: groupId };
        const { data: row, error } = notice
          ? await sb.from("gw_announcements").update(fields).eq("id", notice.id).select("id, message, level, starts_at, group_id, created_by").single()
          : await sb.from("gw_announcements").insert({ ...fields, created_by: profile.id }).select("id, message, level, starts_at, group_id, created_by").single();
        if (error) return ($("[data-err]", dlg.el).innerHTML = GW.alertBox(t("widgets.postFailed")));
        dlg.close();
        if (notice) {
          Object.assign(notice, row);
          draw();
          return toast(t("widgets.saved"));
        }
        row.author = profile.full_name;
        // 发给自己不在的 Business 时，自己的公告栏不会显示，只提示已发布
        if (!groupId || (opts && opts.memberOf && opts.memberOf.includes(groupId))) {
          data.announcements = [row, ...data.announcements];
          draw();
        }
        toast(t("widgets.posted"));
      });
    }

    async function deleteNotice(id) {
      if (!(await confirmDialog(t("widgets.deleteNotice"), t("widgets.deleteNoticeBody"), t("widgets.delete"), t("settings.cancel")))) return;
      const { error } = await sb.from("gw_announcements").delete().eq("id", id);
      if (error) return toast(t("widgets.postFailed"));
      data.announcements = data.announcements.filter((a) => a.id !== id);
      draw();
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
            .insert({ user_id: data.profile.id, name, color: "slate", sort_order: nextSlot(1, 1) })
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
      // 文件夹里的 App 回到主画面的空格
      const ids = folderApps(fid);
      const lks = folderLinks(fid);
      folders = folders.filter((x) => x.id !== fid);
      lks.forEach((l) => {
        l.folder_id = null;
        l.sort_order = nextSlot(1, 1);
      });
      const moved = ids.map((id) => {
        const slot = nextSlot(1, 1);
        layout.set(id, { folder_id: null, sort_order: slot });
        return { module_id: id, folder_id: null, sort_order: slot };
      });
      draw();
      await Promise.all(lks.map((l) => sb.from("gw_user_links").update({ folder_id: null, sort_order: l.sort_order }).eq("id", l.id)));
      const { error } = await sb.from("gw_user_folders").delete().eq("id", fid);
      if (error) return toast(t("home.saveFailed"));
      await saveApps(moved);
    }

    async function open(id) {
      if (readOnly || editing || Date.now() - lastDragEnd < 300) return;
      const m = modules.get(id);
      data.recent = [id, ...data.recent.filter((x) => x !== id)].slice(0, 5);
      if (m.is_new) {
        m.is_new = false;
        if (sectionsOn) sb.rpc("gw_mark_seen", { p_modules: [id] });
      }
      const ok = await openModule(m);
      if (!ok) toast(t("home.openFailed"));
    }

    // ------------------------------------------------------------ 事件（委派）
    let noteTimer;
    root.addEventListener("click", (e) => {
      if (Date.now() - lastDragEnd < 400) return; // 刚拖完，不算点击
      const b = e.target.closest("button");
      if (!b || !root.contains(b)) {
        if (sectionsOn && companyMenuGid) return ((companyMenuGid = null), draw());
        if (fabOpen && !e.target.closest("[data-fab-toggle]")) ((fabOpen = false), draw());
        return;
      }
      const d = b.dataset;
      if (sectionsOn) {
        if (companyMenuGid && !("companyMenu" in d) && !("companyPick" in d)) companyMenuGid = null;
        if ("companyMenu" in d) return ((companyMenuGid = companyMenuGid === d.companyMenu ? null : d.companyMenu), draw());
        if ("companyPick" in d) {
          companyMenuGid = null;
          companySel.set(d.gid, d.companyPick);
          draw();
          const w = board();
          if (!w) return;
          w.config = { ...(w.config || {}), companies: Object.fromEntries(companySel) };
          return sb.from("gw_user_widgets").update({ config: w.config }).eq("id", w.id).then(({ error }) => error && toast(t("home.saveFailed")));
        }
        if (d.mode) return stepBox(d.gid || b.closest("[data-sec-key]").dataset.secKey, d.mode);
        if (d.openFolder) return openBoxFolder(d.openFolder);
        if (d.openNote) return itemDialog(sItems.find((x) => x.id === d.openNote), null, "note");
        if (d.removeFw) return removeWidget(d.removeFw);
        if ("weatherRetry" in d) return ((weather = null), $$("[data-weather]", root).forEach((el) => (el.innerHTML = weatherInner(el.dataset.weather))), loadWeather(true));
      }
      if (d.open) return open(d.open);
      if (d.openLink) {
        if (editing || Date.now() - lastDragEnd < 300) return;
        const l = links.find((x) => x.id === d.openLink);
        return l && window.open(l.url, "_blank", "noopener,noreferrer");
      }
      if (d.editLink) return linkDialog(links.find((x) => x.id === d.editLink));
      if (d.removeLink) return removeLink(d.removeLink);
      if (d.folder) return editing ? null : openFolder(d.folder);
      if (d.appMenu) return appMenu(d.appMenu);
      if (d.removeApp) return removeApp(d.removeApp);
      if (d.removeWidget) return removeWidget(d.removeWidget);
      if (d.removeFolder) return deleteFolder(d.removeFolder);
      if (d.resize) return resizeWidget(d.resize);
      if ("post" in d) return postNotice();
      if (d.aiSuggest) return aiAsk(d.aiSuggest);
      if (d.aiDl) return aiDownload(d.aiDl);
      if ("aiClear" in d) return ((aiMsgs = []), aiSave(), draw());
      if (d.react) return toggleReaction(...d.react.split(":"));
      if (d.who) return whoReacted(...d.who.split(":"));
      if (d.editNotice) return postNotice(data.announcements.find((a) => a.id === d.editNotice));
      if (d.delNotice) return deleteNotice(d.delNotice);
      if ("fabToggle" in d) return ((fabOpen = !fabOpen), draw());
      if (d.fab) {
        fabOpen = false;
        if (d.fab === "icons") return draw(), iconColorsDialog();
        if (d.fab === "tidy") return draw(), tidyWidgets();
        if (d.fab === "add-widget") sheet = "widgets";
        else if (d.fab === "add-apps") sheet = "apps";
        else if (d.fab === "edit") ((editing = true), (sheet = null));
        else if (d.fab === "new-folder") return draw(), folderDialog(null);
        else if (d.fab === "add-link") return draw(), linkDialog(null);
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
        const match = (m) => [m.name, m.code, m.description].some((v) => v && v.toLowerCase().includes(q));
        // 区块版：同一个模块在好几个 Business 都有，所以每个结果都写上它属于哪个 Business（和 Company），才不会进错
        let hits;
        if (sectionsOn && q) {
          hits = [];
          S.groups.forEach((g) => modsOfGroup(g.id).forEach((m) => {
            if (!match(m)) return;
            const cs = companiesOf(g.id);
            const tagged = cs.filter((c) => S.moduleCompanies.some((x) => x.module_id === m.id && x.company_id === c.id));
            const names = (tagged.length ? tagged : cs.length === 1 ? cs : []).map((c) => c.short_name || c.code || c.name);
            hits.push({ m, label: g.name + (names.length ? " · " + names.join(", ") : "") });
          }));
          hits = hits.slice(0, 8);
        } else hits = q ? data.modules.filter(match).slice(0, 6).map((m) => ({ m, label: "" })) : [];
        box.innerHTML = q && !hits.length
          ? `<p class="text-sm text-slate-400">${esc(t("home.noResults"))}</p>`
          : hits.map(({ m, label }) => `<button type="button" data-open="${m.id}" class="no-drag flex w-24 shrink-0 flex-col items-center gap-1">${appIcon(m, "size-11")}<span class="w-full truncate text-center text-[11px] font-medium">${esc(m.name)}</span>${label ? `<span class="w-full truncate text-center text-[10px] text-slate-500" title="${esc(label)}">${esc(label)}</span>` : ""}</button>`).join("");
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
