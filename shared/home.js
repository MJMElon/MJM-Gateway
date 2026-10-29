/* ================================================================
   MJM Gateway — 首页版面（首页与「以此人身份预览」共用）
   拖拉用 SortableJS：卡片可在「未分类」与各文件夹之间拖动，
   模块库抽屉里的模块可拖进首页。手机长按 250ms 开始拖拉。
   版面存 gw_user_layout；没权限的模块不显示，但版面记录保留。
   ================================================================ */
window.GWHome = (function () {
  const { sb, t, esc, $, $$, icon, moduleIcon, cls, btn, modal, confirmDialog, toast, openModule, refreshIcons } = GW;
  const ROOT = "root";
  const COLORS = {
    slate: { dot: "bg-slate-400", bar: "border-l-slate-400" },
    blue: { dot: "bg-blue-500", bar: "border-l-blue-500" },
    green: { dot: "bg-emerald-500", bar: "border-l-emerald-500" },
    amber: { dot: "bg-amber-500", bar: "border-l-amber-500" },
    purple: { dot: "bg-violet-500", bar: "border-l-violet-500" },
    rose: { dot: "bg-rose-500", bar: "border-l-rose-500" },
    teal: { dot: "bg-teal-500", bar: "border-l-teal-500" },
  };
  const color = (key) => COLORS[key] || COLORS.slate;
  // 卡片宽度：大 = 2 格、小 = 1 格、列表 = 整行
  const SPAN = { large: "col-span-2", small: "col-span-1", list: "col-span-full" };
  const GRID = "grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6";

  function render(root, data, opts) {
    const readOnly = !!(opts && opts.readOnly);
    const uninitialized = readOnly && !data.profile.layout_initialized;
    const modules = new Map(data.modules.map((m) => [m.id, m]));
    let folders = data.folders.slice();
    let containers = {};
    const sizes = Object.fromEntries(data.layout.map((l) => [l.module_id, l.card_size]));
    let recent = data.recent.slice();
    let query = "";
    let libraryOpen = false;
    let libraryTarget = ROOT;
    let lastDragEnd = 0;
    let sortables = [];

    // ------------------------------------------------------------ 版面资料
    containers[ROOT] = [];
    folders.forEach((f) => (containers[f.id] = []));
    if (uninitialized) {
      containers[ROOT] = data.modules.map((m) => m.id);
    } else {
      data.layout
        .slice()
        .sort((a, b) => a.sort_order - b.sort_order)
        .forEach((l) => containers[l.folder_id && containers[l.folder_id] ? l.folder_id : ROOT].push(l.module_id));
    }
    const onHome = () => new Set(Object.values(containers).flat());
    const findContainer = (id) => Object.keys(containers).find((k) => containers[k].includes(id));
    const sortedFolders = () => folders.slice().sort((a, b) => a.sort_order - b.sort_order);

    async function persist() {
      if (readOnly) return;
      const items = Object.entries(containers).flatMap(([key, ids]) =>
        ids.map((id, i) => ({
          module_id: id,
          folder_id: key === ROOT ? null : key,
          sort_order: i + 1,
          card_size: sizes[id] || "large",
        })),
      );
      const { error } = await sb.rpc("gw_save_layout", { p_items: items });
      if (error) toast(t("home.saveFailed"));
    }

    async function open(id) {
      if (readOnly || Date.now() - lastDragEnd < 300) return;
      const m = modules.get(id);
      recent = [id, ...recent.filter((x) => x !== id)].slice(0, 5);
      const ok = await openModule(m);
      if (!ok) toast(t("home.openFailed"));
      draw();
    }

    // ------------------------------------------------------------ 已关闭的公告（存在浏览器）
    const dismissed = (() => {
      try {
        return JSON.parse(localStorage.getItem("gw_dismissed_announcements") || "[]");
      } catch (e) {
        return [];
      }
    })();
    function dismiss(id) {
      dismissed.push(id);
      try {
        localStorage.setItem("gw_dismissed_announcements", JSON.stringify(dismissed.slice(-50)));
      } catch (e) {
        /* localStorage 不可用时无法记住，忽略 */
      }
      draw();
    }

    // ------------------------------------------------------------ 画面片段
    const newBadge = (m) =>
      m.is_new ? `<span class="rounded bg-rose-500 px-1 text-[10px] font-bold leading-4 text-white">${esc(t("home.new"))}</span>` : "";

    function cardHtml(id, size, withMenu) {
      const m = modules.get(id);
      if (!m) return "";
      const base =
        "group relative h-full w-full select-none rounded-xl border border-slate-200 bg-white text-left transition-shadow hover:shadow-md dark:border-slate-800 dark:bg-slate-900";
      const menu = withMenu
        ? `<button type="button" data-menu="${id}" aria-label="${esc(t("home.cardMenu"))}" class="no-drag rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100 dark:hover:bg-slate-800">${icon("ellipsis-vertical")}</button>`
        : "";
      const iconBox = (sz) =>
        `<span class="flex shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-700/20 dark:text-brand-100 ${sz}">`;
      if (size === "list") {
        return `<div class="${base} flex items-center gap-3 px-3 py-2.5">
          <button type="button" data-open="${id}" class="flex min-w-0 flex-1 items-center gap-3 text-left">
            ${iconBox("size-8 rounded-lg")}${moduleIcon(m.icon, "size-4")}</span>
            <span class="min-w-0 flex-1">
              <span class="flex items-center gap-1.5 text-sm font-medium"><span class="truncate">${esc(m.name)}</span>${newBadge(m)}</span>
              ${m.description ? `<span class="block truncate text-xs text-slate-500">${esc(m.description)}</span>` : ""}
            </span>
          </button>${menu}</div>`;
      }
      const large = size === "large";
      return `<div class="${base} ${large ? "p-4" : "p-3"}">
        <button type="button" data-open="${id}" class="flex h-full w-full text-left ${large ? "items-start gap-3" : "flex-col items-center gap-2 text-center"}">
          ${iconBox(large ? "size-11" : "size-10")}${moduleIcon(m.icon, large ? "size-6" : "size-5")}</span>
          <span class="min-w-0 flex-1">
            <span class="flex items-center gap-1.5 font-medium ${large ? "text-sm" : "justify-center text-xs"}"><span class="${large ? "truncate" : "line-clamp-2"}">${esc(m.name)}</span>${newBadge(m)}</span>
            ${large && m.description ? `<span class="mt-0.5 block truncate text-xs text-slate-500">${esc(m.description)}</span>` : ""}
          </span>
        </button>
        ${menu ? `<div class="absolute top-1.5 right-1.5">${menu}</div>` : ""}
      </div>`;
    }

    // 空的区域也保留放置空间并显示提示，拖进空文件夹更容易
    const gridHtml = (key, hint) => {
      const ids = containers[key].filter((id) => modules.has(id));
      return `<div class="relative">
        ${ids.length === 0 && hint ? `<p class="pointer-events-none absolute inset-0 flex items-center justify-center rounded-xl border border-dashed border-slate-300 text-xs text-slate-400 dark:border-slate-700">${esc(hint)}</p>` : ""}
        <div class="gw-grid ${GRID} ${ids.length === 0 && hint ? "min-h-14" : "min-h-4"}" data-container="${key}">${ids
          .map((id) => `<div class="${SPAN[sizes[id] || "large"]}" data-id="${id}">${cardHtml(id, sizes[id] || "large", !readOnly)}</div>`)
          .join("")}</div>
      </div>`;
    };

    const iconBtn = (attr, label, name, disabled) =>
      `<button ${attr} aria-label="${esc(label)}" title="${esc(label)}" ${disabled ? "disabled" : ""} class="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30 dark:hover:bg-slate-800">${icon(name)}</button>`;

    function folderHtml(f, i, total) {
      const c = color(f.color);
      return `<section class="rounded-xl border-l-4 bg-white/60 p-3 dark:bg-slate-900/40 ${c.bar}">
        <div class="flex items-center gap-2">
          <button data-toggle="${f.id}" aria-expanded="${!f.collapsed}" class="flex min-w-0 flex-1 items-center gap-2 text-left">
            ${icon(f.collapsed ? "chevron-right" : "chevron-down", "size-4 shrink-0")}
            <span class="size-2.5 shrink-0 rounded-full ${c.dot}"></span>
            <span class="truncate font-medium">${esc(f.name)}</span>
            <span class="text-xs text-slate-400">${containers[f.id].length}</span>
          </button>
          ${
            readOnly
              ? ""
              : `<div class="flex items-center">
                  ${iconBtn(`data-up="${f.id}"`, t("home.moveUp"), "arrow-up", i === 0)}
                  ${iconBtn(`data-down="${f.id}"`, t("home.moveDown"), "arrow-down", i === total - 1)}
                  ${iconBtn(`data-edit="${f.id}"`, t("home.editFolder"), "pencil")}
                  ${iconBtn(`data-del="${f.id}"`, t("home.deleteFolder"), "trash-2")}
                </div>`
          }
        </div>
        <div class="gw-folder-body mt-3 ${f.collapsed ? "hidden" : ""}">
          ${gridHtml(f.id, readOnly ? "" : t("home.emptyFolder"))}
        </div>
      </section>`;
    }

    function libraryHtml() {
      const home = onHome();
      return `<aside class="fixed inset-x-0 bottom-0 z-40 max-h-[70vh] overflow-y-auto rounded-t-2xl border border-slate-200 bg-white p-4 shadow-2xl lg:sticky lg:top-20 lg:z-auto lg:max-h-[calc(100dvh-7rem)] lg:rounded-xl lg:shadow-none dark:border-slate-800 dark:bg-slate-900">
        <div class="mb-3 flex items-center justify-between">
          <h3 class="font-semibold">${esc(t("home.library"))}</h3>
          ${iconBtn('data-close-library', t("home.close"), "x")}
        </div>
        <p class="mb-3 text-xs text-slate-500">${esc(t("home.libraryHint"))}</p>
        ${
          folders.length
            ? `<select data-library-target class="${cls.input} mb-3">
                <option value="${ROOT}">${esc(t("home.addTo", { name: t("home.uncategorized") }))}</option>
                ${sortedFolders()
                  .map((f) => `<option value="${f.id}" ${libraryTarget === f.id ? "selected" : ""}>${esc(t("home.addTo", { name: f.name }))}</option>`)
                  .join("")}
              </select>`
            : ""
        }
        <ul class="gw-library space-y-2">
          ${data.modules
            .map((m) => {
              const added = home.has(m.id);
              return `<li data-lib="${m.id}" class="${added ? "gw-added" : "cursor-grab"} flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-2 dark:border-slate-800 dark:bg-slate-900">
                <span class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-700/20 dark:text-brand-100">${moduleIcon(m.icon, "size-4")}</span>
                <span class="min-w-0 flex-1">
                  <span class="flex items-center gap-1.5 text-sm font-medium"><span class="truncate">${esc(m.name)}</span>${added ? "" : newBadge(m)}</span>
                  ${m.description ? `<span class="block truncate text-xs text-slate-500">${esc(m.description)}</span>` : ""}
                </span>
                ${
                  added
                    ? `<span class="text-emerald-600" title="${esc(t("home.onHome"))}">${icon("check")}</span>`
                    : `<button data-add="${m.id}" aria-label="${esc(t("home.addToHome"))}" class="no-drag rounded-md p-1.5 text-brand-600 hover:bg-brand-50 dark:text-brand-100 dark:hover:bg-brand-700/20">${icon("plus")}</button>`
                }
              </li>`;
            })
            .join("")}
        </ul>
      </aside>`;
    }

    // ------------------------------------------------------------ 整页
    function draw() {
      sortables.forEach((s) => s.destroy());
      sortables = [];
      const announcements = data.announcements.filter((a) => !dismissed.includes(a.id));
      const q = query.trim().toLowerCase();
      const results = q
        ? data.modules.filter((m) => [m.name, m.code, m.description, m.category].some((v) => v && v.toLowerCase().includes(q)))
        : [];
      const home = onHome();
      const newCount = data.modules.filter((m) => m.is_new && !home.has(m.id)).length;
      const sf = sortedFolders();

      root.innerHTML = `<div class="space-y-5">
        ${announcements
          .map(
            (a) => `<div class="flex items-start gap-2 rounded-xl border px-3 py-2.5 text-sm ${
              a.level === "warning"
                ? "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
                : "border-brand-100 bg-brand-50 text-brand-700 dark:border-brand-700/40 dark:bg-brand-700/10 dark:text-brand-100"
            }">
              ${icon(a.level === "warning" ? "triangle-alert" : "megaphone", "mt-0.5 size-4 shrink-0")}
              <p class="flex-1 whitespace-pre-line">${esc(a.message)}</p>
              ${readOnly ? "" : `<button data-dismiss="${a.id}" aria-label="${esc(t("home.dismiss"))}" class="rounded p-0.5 opacity-60 hover:opacity-100">${icon("x")}</button>`}
            </div>`,
          )
          .join("")}
        ${
          uninitialized
            ? `<div class="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">${icon("info")} ${esc(t("home.previewUninitialized"))}</div>`
            : ""
        }
        <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div class="relative flex-1">
            <span class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400">${icon("search")}</span>
            <input data-search type="search" value="${esc(query)}" placeholder="${esc(t("home.searchPlaceholder"))}" class="${cls.input} pl-9">
          </div>
          ${
            readOnly
              ? ""
              : `<div class="flex gap-2">
                  <button data-new-folder class="${btn("secondary")} flex-1 sm:flex-none">${icon("folder-plus")} ${esc(t("home.newFolder"))}</button>
                  <button data-open-library class="${btn("secondary")} relative flex-1 sm:flex-none">${icon("library")} ${esc(t("home.library"))}
                    ${newCount ? `<span class="absolute -top-1.5 -right-1.5 rounded-full bg-rose-500 px-1.5 text-[10px] font-bold leading-4 text-white">${newCount}</span>` : ""}
                  </button>
                </div>`
          }
        </div>
        ${
          !q && recent.some((id) => modules.has(id))
            ? `<div>
                <h3 class="mb-2 flex items-center gap-1.5 text-sm font-medium text-slate-500">${icon("clock")} ${esc(t("home.recent"))}</h3>
                <div class="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
                  ${recent
                    .filter((id) => modules.has(id))
                    .map((id) => {
                      const m = modules.get(id);
                      return `<button data-open="${id}" class="flex shrink-0 items-center gap-2 rounded-full border border-slate-200 bg-white py-1.5 pr-3 pl-1.5 text-sm hover:border-brand-500 dark:border-slate-800 dark:bg-slate-900">
                        <span class="flex size-6 items-center justify-center rounded-full bg-brand-50 text-brand-600 dark:bg-brand-700/20 dark:text-brand-100">${moduleIcon(m.icon, "size-3.5")}</span>${esc(m.name)}</button>`;
                    })
                    .join("")}
                </div>
              </div>`
            : ""
        }
        ${
          q
            ? `<div>
                <h3 class="mb-2 text-sm font-medium text-slate-500">${esc(t("home.searchResults", { count: results.length }))}</h3>
                ${
                  results.length
                    ? `<div class="${GRID}">${results.map((m) => `<div class="${SPAN.large}">${cardHtml(m.id, "large", false)}</div>`).join("")}</div>`
                    : `<div class="${cls.empty}">${esc(t("home.noResults"))}</div>`
                }
              </div>`
            : `<div class="${libraryOpen ? "lg:grid lg:grid-cols-[1fr_20rem] lg:gap-5" : ""}">
                <div class="space-y-4">
                  ${sf.map((f, i) => folderHtml(f, i, sf.length)).join("")}
                  <div>
                    ${folders.length ? `<h3 class="mb-2 text-sm font-medium text-slate-500">${esc(t("home.uncategorized"))}</h3>` : ""}
                    ${
                      home.size === 0
                        ? `${gridHtml(ROOT)}<div class="${cls.empty}">${esc(data.modules.length ? t("home.emptyHome") : t("home.noModules"))}</div>`
                        : gridHtml(ROOT, readOnly ? "" : t("home.emptyFolder"))
                    }
                  </div>
                </div>
                ${libraryOpen ? libraryHtml() : ""}
              </div>
              ${!readOnly && home.size ? `<p class="mt-5 text-center text-xs text-slate-400">${esc(t("home.dragHint"))}</p>` : ""}`
        }
      </div>`;
      refreshIcons();
      if (!readOnly && !q) setupSortable();
    }

    // ------------------------------------------------------------ 拖拉
    function readDom() {
      const next = {};
      $$(".gw-grid", root).forEach((g) => {
        next[g.dataset.container] = $$(":scope > [data-id]", g).map((el) => el.dataset.id);
      });
      // 文件夹之外（例如搜索时）没出现在画面的保留原样
      Object.keys(containers).forEach((k) => {
        if (!next[k]) next[k] = containers[k];
      });
      containers = next;
    }

    function setupSortable() {
      const common = {
        group: { name: "gw", pull: true, put: true },
        animation: 150,
        delay: 250,
        delayOnTouchOnly: true,
        filter: ".no-drag",
        preventOnFilter: false,
        emptyInsertThreshold: 40,
        onStart: () => document.body.classList.add("gw-dragging"),
        onEnd: () => {
          document.body.classList.remove("gw-dragging");
          lastDragEnd = Date.now();
        },
      };
      $$(".gw-grid", root).forEach((grid) => {
        sortables.push(
          window.Sortable.create(grid, {
            ...common,
            onAdd: (evt) => {
              // 从模块库拖进来：换成真正的卡片
              const libId = evt.item.dataset.lib;
              if (libId) {
                evt.item.dataset.id = libId;
                delete evt.item.dataset.lib;
                sb.rpc("gw_mark_seen", { p_modules: [libId] });
              }
            },
            onEnd: () => {
              common.onEnd();
              readDom();
              persist();
              draw();
            },
          }),
        );
      });
      const lib = $(".gw-library", root);
      if (lib) {
        sortables.push(
          window.Sortable.create(lib, {
            group: { name: "gw", pull: "clone", put: false },
            sort: false,
            animation: 150,
            delay: 250,
            delayOnTouchOnly: true,
            filter: ".no-drag, .gw-added",
            onStart: common.onStart,
            onEnd: (evt) => {
              document.body.classList.remove("gw-dragging");
              lastDragEnd = Date.now();
              if (evt.to !== lib) {
                readDom();
                persist();
                draw();
              }
            },
          }),
        );
      }
    }

    // ------------------------------------------------------------ 卡片选单
    function cardMenu(id) {
      const m = modules.get(id);
      const current = sizes[id] || "large";
      const dlg = modal(
        m.name,
        `<div class="space-y-5">
          <div>
            <p class="mb-2 text-sm font-medium">${esc(t("home.cardSize"))}</p>
            <div class="grid grid-cols-3 gap-2">
              ${["large", "small", "list"].map((s) => `<button data-size="${s}" class="${btn(s === current ? "primary" : "secondary")}">${esc(t("home.size." + s))}</button>`).join("")}
            </div>
          </div>
          <div>
            <p class="mb-2 text-sm font-medium">${esc(t("home.moveTo"))}</p>
            <select data-move class="${cls.input}">
              <option value="${ROOT}">${esc(t("home.uncategorized"))}</option>
              ${sortedFolders().map((f) => `<option value="${f.id}" ${findContainer(id) === f.id ? "selected" : ""}>${esc(f.name)}</option>`).join("")}
            </select>
          </div>
          <button data-remove class="${btn("ghost")} w-full text-red-600 dark:text-red-400">${icon("trash-2")} ${esc(t("home.removeFromHome"))}</button>
        </div>`,
      );
      dlg.el.querySelectorAll("[data-size]").forEach((b) =>
        b.addEventListener("click", () => {
          sizes[id] = b.dataset.size;
          persist();
          dlg.close();
          draw();
        }),
      );
      dlg.el.querySelector("[data-move]").addEventListener("change", (e) => {
        const from = findContainer(id);
        containers[from] = containers[from].filter((x) => x !== id);
        containers[e.target.value].push(id);
        persist();
        dlg.close();
        draw();
      });
      dlg.el.querySelector("[data-remove]").addEventListener("click", async () => {
        const from = findContainer(id);
        containers[from] = containers[from].filter((x) => x !== id);
        dlg.close();
        draw();
        const { error } = await sb.from("gw_user_layout").delete().eq("module_id", id).eq("user_id", data.profile.id);
        if (error) toast(t("home.saveFailed"));
      });
    }

    // ------------------------------------------------------------ 文件夹
    function folderDialog(folder) {
      let chosen = folder ? folder.color : "blue";
      const dlg = modal(
        folder ? t("home.editFolder") : t("home.newFolder"),
        `<form class="space-y-4">
          <input name="name" maxlength="40" required value="${esc(folder ? folder.name : "")}" placeholder="${esc(t("home.folderName"))}" class="${cls.input}">
          <div>
            <p class="mb-2 text-sm font-medium">${esc(t("home.folderColor"))}</p>
            <div class="flex flex-wrap gap-2">
              ${Object.keys(COLORS).map((k) => `<button type="button" data-color="${k}" aria-label="${k}" class="flex size-9 items-center justify-center rounded-full ${COLORS[k].dot}"></button>`).join("")}
            </div>
          </div>
          <div class="flex justify-end gap-2">
            <button type="button" data-cancel class="${btn("secondary")}">${esc(t("home.cancel"))}</button>
            <button type="submit" class="${btn("primary")}">${esc(t("home.save"))}</button>
          </div>
        </form>`,
      );
      const paint = () =>
        dlg.el.querySelectorAll("[data-color]").forEach((b) => {
          const on = b.dataset.color === chosen;
          b.classList.toggle("ring-2", on);
          b.classList.toggle("ring-offset-2", on);
          b.classList.toggle("ring-slate-900", on);
          b.innerHTML = on ? icon("check", "size-4 text-white") : "";
        });
      dlg.el.querySelectorAll("[data-color]").forEach((b) => b.addEventListener("click", () => ((chosen = b.dataset.color), paint(), refreshIcons())));
      paint();
      refreshIcons();
      dlg.el.querySelector("[data-cancel]").onclick = dlg.close;
      const input = dlg.el.querySelector("[name=name]");
      input.focus();
      dlg.el.querySelector("form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const name = input.value.trim();
        if (!name) return;
        if (folder) {
          folder.name = name;
          folder.color = chosen;
          await sb.from("gw_user_folders").update({ name, color: chosen }).eq("id", folder.id);
        } else {
          const sortOrder = Math.max(0, ...folders.map((f) => f.sort_order)) + 1;
          const { data: created, error } = await sb
            .from("gw_user_folders")
            .insert({ user_id: data.profile.id, name, color: chosen, sort_order: sortOrder })
            .select("id, name, color, sort_order, collapsed")
            .single();
          if (error) return toast(t("home.saveFailed"));
          folders.push(created);
          containers[created.id] = [];
        }
        dlg.close();
        draw();
      });
    }

    async function moveFolder(id, dir) {
      const list = sortedFolders();
      const i = list.findIndex((f) => f.id === id);
      const j = i + dir;
      if (j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      list.forEach((f, k) => (f.sort_order = k + 1));
      folders = list;
      draw();
      await Promise.all(list.map((f) => sb.from("gw_user_folders").update({ sort_order: f.sort_order }).eq("id", f.id)));
    }

    async function deleteFolder(id) {
      const f = folders.find((x) => x.id === id);
      const ok = await confirmDialog(t("home.deleteFolderTitle"), t("home.deleteFolderBody", { name: f.name }), t("home.delete"), t("home.cancel"));
      if (!ok) return;
      // 删除文件夹：里面的模块回到未分类
      containers[ROOT] = containers[ROOT].concat(containers[id] || []);
      delete containers[id];
      folders = folders.filter((x) => x.id !== id);
      draw();
      const { error } = await sb.from("gw_user_folders").delete().eq("id", id);
      if (error) return toast(t("home.saveFailed"));
      persist();
    }

    async function addToHome(id) {
      if (onHome().has(id)) return;
      containers[libraryTarget].push(id);
      draw();
      await persist();
      sb.rpc("gw_mark_seen", { p_modules: [id] });
      toast(t("home.added"));
    }

    // ------------------------------------------------------------ 事件（委派）
    root.addEventListener("click", (e) => {
      const el = e.target.closest("button");
      if (!el || !root.contains(el)) return;
      const d = el.dataset;
      if (d.open) open(d.open);
      else if (d.menu) cardMenu(d.menu);
      else if (d.dismiss) dismiss(d.dismiss);
      else if (d.toggle !== undefined && d.toggle) {
        const f = folders.find((x) => x.id === d.toggle);
        f.collapsed = !f.collapsed;
        draw();
        if (!readOnly) sb.from("gw_user_folders").update({ collapsed: f.collapsed }).eq("id", f.id);
      } else if (d.up) moveFolder(d.up, -1);
      else if (d.down) moveFolder(d.down, 1);
      else if (d.edit) folderDialog(folders.find((x) => x.id === d.edit));
      else if (d.del) deleteFolder(d.del);
      else if ("newFolder" in d) folderDialog(null);
      else if ("openLibrary" in d) ((libraryOpen = true), draw());
      else if ("closeLibrary" in d) ((libraryOpen = false), draw());
      else if (d.add) addToHome(d.add);
    });
    root.addEventListener("input", (e) => {
      if (e.target.matches("[data-search]")) {
        query = e.target.value;
        const pos = e.target.selectionStart;
        draw();
        const input = $("[data-search]", root);
        input.focus();
        input.setSelectionRange(pos, pos);
      }
    });
    root.addEventListener("change", (e) => {
      if (e.target.matches("[data-library-target]")) libraryTarget = e.target.value;
    });

    draw();
  }

  return { render };
})();
