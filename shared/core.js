/* ================================================================
   MJM Gateway — 共用核心
   Supabase 连线、登录检查、多语言、页面外框（顶栏 / 手机底部导航）、
   对话框、提示、Edge Function 调用、Excel。
   所有资料权限都由数据库 RLS 检查；这里的页面保护只负责导航。
   ================================================================ */
window.GW = (function () {
  const cfg = window.GW_CONFIG;
  // 网站根目录（模块页面放在子资料夹，例如 diesel/，连结都要从根目录算）
  const BASE = document.currentScript ? document.currentScript.src.replace(/shared\/core\.js.*$/, "") : "";
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { flowType: "pkce", persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  // ---------------------------------------------------------------- 多语言
  // 预设英文；个人设置可改语言（存在这台装置）
  const LOCALE = (() => {
    try {
      const saved = localStorage.getItem("gw_locale");
      if (saved && window.GW_LANG[saved]) return saved;
    } catch (e) {
      /* 忽略 */
    }
    return "en";
  })();
  const LANG = window.GW_LANG[LOCALE];
  document.documentElement.lang = LOCALE;

  function t(key, vars) {
    const value = key.split(".").reduce((o, k) => (o == null ? o : o[k]), LANG);
    if (typeof value !== "string") return key;
    return vars ? value.replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? "" : vars[k])) : value;
  }

  // ---------------------------------------------------------------- 小工具
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESC[c]);
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function icon(name, cls) {
    return `<i data-lucide="${esc(name)}" class="${esc(cls || "size-4")}"></i>`;
  }
  function refreshIcons() {
    window.lucide.createIcons();
  }

  function fmtDateTime(iso, opts) {
    return new Intl.DateTimeFormat(LOCALE, { timeZone: cfg.timeZone, dateStyle: "medium", timeStyle: "short", ...opts }).format(
      new Date(iso),
    );
  }

  function go(path) {
    location.href = BASE + path;
  }

  // ---------------------------------------------------------------- 主题
  function applyTheme(theme) {
    try {
      localStorage.setItem("gw_theme", theme);
    } catch (e) {
      /* 忽略 */
    }
    const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
  }

  // ---------------------------------------------------------------- 登录状态
  async function loadProfile() {
    const { data } = await sb.auth.getSession();
    const session = data.session;
    if (!session) return { session: null, profile: null };
    const { data: profile } = await sb.from("gw_profiles").select("*").eq("id", session.user.id).maybeSingle();
    if (profile) {
      // 自订角色：管哪些 Business、能不能发公告（RLS 只给看自己的角色）
      profile.isSuper = profile.role === "super_admin";
      profile.roleName = null;
      profile.canPost = profile.isSuper;
      profile.businessIds = [];
      profile.adminModules = 0;
      if (!profile.isSuper) {
        // 模块管理员：可以开 / 收回自己管理的模块的权限
        const { count } = await sb.from("gw_module_members").select("module_id", { count: "exact", head: true }).eq("user_id", profile.id).eq("is_admin", true);
        profile.adminModules = count || 0;
      }
      if (!profile.isSuper && profile.role_id) {
        const [{ data: role }, { data: biz }] = await Promise.all([
          sb.from("gw_roles").select("name, can_post_notice").eq("id", profile.role_id).maybeSingle(),
          sb.from("gw_role_businesses").select("group_id").eq("role_id", profile.role_id),
        ]);
        profile.roleName = role ? role.name : null;
        profile.canPost = !!(role && role.can_post_notice);
        profile.businessIds = (biz || []).map((b) => b.group_id);
      }
      // 有管理权（super_admin、角色管至少一个 Business、或是某个模块的管理员）→ 右上角齿轮进设置页
      profile.manages = profile.isSuper || profile.businessIds.length > 0 || profile.adminModules > 0;
    }
    return { session, profile };
  }

  /* 页面保护：未登录 → 登录页；没有 Gateway 资料或已停用 → 登录页；
     未改初始密码 → 改密码；权限不足 → 首页。need = "user" | "manage"（super_admin 或有管理权的角色）| "super" */
  async function requireProfile(need) {
    const { session, profile } = await loadProfile();
    if (!session) return go("login.html"), null;
    if (!profile || profile.status !== "active") {
      await sb.auth.signOut();
      return go("login.html?error=no_access"), null;
    }
    if (profile.must_change_password) return go("login.html?mode=change"), null;
    if ((need === "manage" && !profile.manages) || (need === "super" && !profile.isSuper)) {
      return go(need === "super" && profile.manages ? "admin.html" : "index.html"), null;
    }
    applyTheme(profile.theme);
    return profile;
  }

  async function logout() {
    await sb.auth.signOut();
    go("login.html");
  }

  /* 改密码：回传错误代码（too_short / weak / mismatch / same / unknown）或 null */
  async function changePassword(password, confirm) {
    if (password.length < 8) return "too_short";
    if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return "weak";
    if (password !== confirm) return "mismatch";
    const { error } = await sb.auth.updateUser({ password });
    if (error) return error.code === "same_password" ? "same" : "unknown";
    await invoke("gw-auth", { action: "password_changed" });
    return null;
  }

  // ---------------------------------------------------------------- 页面外框
  function shell(profile, active) {
    const isAdmin = profile.manages;
    const header = document.createElement("div");
    header.innerHTML = `
      <header class="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur dark:border-slate-800 dark:bg-slate-950/90">
        <div class="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4">
          <a href="${BASE}index.html" class="text-lg font-bold tracking-tight whitespace-nowrap">${esc(t("app.name"))}</a>
          <div class="ml-auto flex items-center gap-3">
            <a href="${BASE}settings.html" title="${esc(t("nav.settings"))}" class="flex items-center gap-3">
              <div class="hidden text-right leading-tight md:block">
                <div class="text-sm font-medium">${esc(profile.full_name)}</div>
                <div class="text-xs text-slate-500">${esc(profile.email)}</div>
              </div>
              <span class="flex size-8 items-center justify-center rounded-full text-sm font-semibold ${
                active === "settings" ? "bg-slate-900 text-white dark:bg-white dark:text-slate-900" : "bg-slate-200 dark:bg-slate-800"
              }">${esc(profile.full_name.slice(0, 1))}</span>
            </a>
            <a href="${BASE}${isAdmin ? "admin.html" : "settings.html"}" title="${esc(t(isAdmin ? "nav.admin" : "nav.settings"))}" aria-label="${esc(t(isAdmin ? "nav.admin" : "nav.settings"))}" class="rounded-lg p-2 ${
              active === (isAdmin ? "admin" : "settings") ? "bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-white" : "text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-slate-800 dark:hover:text-white"
            }">${icon("settings", "size-5")}</a>
            <button id="gw-logout" class="rounded-lg p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" title="${esc(
              t("nav.logout"),
            )}" aria-label="${esc(t("nav.logout"))}">${icon("log-out")}</button>
          </div>
        </div>
      </header>`;
    document.body.prepend(...header.children);
    $("#gw-logout").addEventListener("click", logout);
    const main = $("#main");
    main.classList.add("mx-auto", "max-w-7xl", "px-4", "py-5", "sm:py-8");
    refreshIcons();
    return main;
  }

  function spinner() {
    return `<div class="flex min-h-[40vh] items-center justify-center"><div class="size-7 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600"></div></div>`;
  }

  // ---------------------------------------------------------------- 共用样式片段
  const cls = {
    input:
      "h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 dark:border-slate-700 dark:bg-slate-900",
    btn: "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 h-10 px-4 text-sm",
    btnSm: "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 h-8 px-2.5 text-sm",
    primary: "bg-brand-600 text-white hover:bg-brand-700",
    secondary:
      "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800",
    ghost: "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800",
    danger: "bg-red-600 text-white hover:bg-red-700",
    card: "rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900",
    label: "text-sm font-medium text-slate-700 dark:text-slate-300",
    empty: "rounded-xl border border-dashed border-slate-300 px-4 py-10 text-center text-sm text-slate-500 dark:border-slate-700",
  };
  const btn = (variant, size) => `${size === "sm" ? cls.btnSm : cls.btn} ${cls[variant || "primary"]}`;

  const BADGE = {
    slate: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
    green: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
    red: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
    amber: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
    blue: "bg-brand-100 text-brand-700 dark:bg-brand-700/30 dark:text-brand-100",
  };
  const badge = (text, tone) =>
    `<span class="inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium ${BADGE[tone || "slate"]}">${esc(text)}</span>`;

  const ALERT = {
    red: "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300",
    green: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-300",
    amber: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-300",
  };
  const alertBox = (text, tone) => `<div class="rounded-lg border px-3 py-2 text-sm ${ALERT[tone || "red"]}">${esc(text)}</div>`;

  // ---------------------------------------------------------------- 对话框 / 提示
  function modal(title, bodyHtml, opts) {
    const wrap = document.createElement("div");
    wrap.className = "fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 sm:items-center sm:p-4";
    wrap.innerHTML = `
      <div role="dialog" aria-modal="true" aria-label="${esc(title)}" class="max-h-[90vh] w-full overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl dark:bg-slate-900 ${
        opts && opts.wide ? "sm:max-w-2xl" : "sm:max-w-md"
      }">
        <div class="mb-4 flex items-center justify-between gap-4">
          <h2 class="text-lg font-semibold">${esc(title)}</h2>
          <button data-close class="rounded-lg p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="close">${icon("x", "size-5")}</button>
        </div>
        <div data-body>${bodyHtml}</div>
      </div>`;
    const close = () => {
      wrap.remove();
      document.removeEventListener("keydown", onKey);
      if (opts && opts.onClose) opts.onClose();
    };
    const onKey = (e) => e.key === "Escape" && close();
    document.addEventListener("keydown", onKey);
    wrap.addEventListener("click", (e) => e.target === wrap && close());
    wrap.querySelector("[data-close]").addEventListener("click", close);
    document.body.appendChild(wrap);
    refreshIcons();
    return { el: wrap.querySelector("[data-body]"), close };
  }

  function confirmDialog(title, text, confirmLabel, cancelLabel) {
    return new Promise((resolve) => {
      let answered = false;
      const m = modal(
        title,
        `<p class="mb-5 text-sm text-slate-600 dark:text-slate-300">${esc(text)}</p>
         <div class="flex justify-end gap-2">
           <button data-no class="${btn("secondary")}">${esc(cancelLabel)}</button>
           <button data-yes class="${btn("danger")}">${esc(confirmLabel)}</button>
         </div>`,
        { onClose: () => !answered && resolve(false) },
      );
      m.el.querySelector("[data-no]").onclick = () => m.close();
      m.el.querySelector("[data-yes]").onclick = () => {
        answered = true;
        m.close();
        resolve(true);
      };
    });
  }

  let toastTimer;
  function toast(text) {
    let el = $("#gw-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "gw-toast";
      el.className = "fixed inset-x-0 bottom-20 z-50 flex justify-center px-4 sm:bottom-6";
      document.body.appendChild(el);
    }
    el.innerHTML = `<div class="rounded-lg bg-slate-900 px-4 py-2 text-sm text-white shadow-lg dark:bg-slate-100 dark:text-slate-900">${esc(text)}</div>`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.innerHTML = ""), 3000);
  }

  // ---------------------------------------------------------------- Edge Functions
  async function invoke(name, body) {
    const { data, error } = await sb.functions.invoke(name, { body });
    if (error) {
      const ctx = error.context;
      if (ctx && typeof ctx.json === "function") {
        try {
          return await ctx.json();
        } catch (e) {
          /* 不是 JSON */
        }
      }
      return { ok: false, error: "network" };
    }
    return data;
  }

  // ---------------------------------------------------------------- Excel（需要时才载入）
  let excelPromise;
  function loadExcel() {
    if (!excelPromise) {
      excelPromise = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js";
        s.onload = () => resolve(window.ExcelJS);
        s.onerror = reject;
        document.head.appendChild(s);
      });
    }
    return excelPromise;
  }

  async function downloadXlsx(filename, build) {
    const ExcelJS = await loadExcel();
    const workbook = new ExcelJS.Workbook();
    build(workbook);
    const buffer = await workbook.xlsx.writeBuffer();
    downloadBlob(
      filename,
      new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    );
  }

  function downloadBlob(filename, blob) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function readXlsxRows(file) {
    const ExcelJS = await loadExcel();
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(await file.arrayBuffer());
    } catch (e) {
      return null;
    }
    const sheet = workbook.worksheets[0];
    if (!sheet) return null;
    const rows = [];
    sheet.eachRow((row, n) => {
      if (n === 1) return;
      const cells = [];
      for (let i = 1; i <= 5; i++) {
        const v = row.getCell(i).value;
        cells.push(v && typeof v === "object" && "text" in v ? String(v.text).trim() : v == null ? "" : String(v).trim());
      }
      rows.push(cells);
    });
    return rows;
  }

  // ---------------------------------------------------------------- 模块图标
  // 模块可选的图标（资料库存 key → lucide 图示名称）
  const MODULE_ICONS = {
    "app-window": "app-window",
    fuel: "fuel",
    truck: "truck",
    tractor: "tractor",
    gauge: "gauge",
    wrench: "wrench",
    factory: "factory",
    "hard-hat": "hard-hat",
    users: "users",
    "file-text": "file-text",
    chart: "chart-column",
    calendar: "calendar",
    "clipboard-list": "clipboard-list",
    database: "database",
    shield: "shield",
    settings: "settings",
    mail: "mail",
    map: "map",
    package: "package",
    "dollar-sign": "dollar-sign",
    building: "building-2",
    "book-open": "book-open",
    "message-square": "message-square",
    camera: "camera",
  };
  const moduleIcon = (key, size) => icon(MODULE_ICONS[key] || "app-window", size);

  // ---------------------------------------------------------------- 打开模块
  /* 第 1 级（外部链接）/ 第 3 级（SSO）：直接打开网址
     第 2 级（Token 跳转）：向 Edge Function 申请 60 秒 Token，再带着 Token 跳转 */
  async function openModule(m) {
    const newTab = m.open_mode === "new_tab";
    if (m.access_level === 2) {
      const win = newTab ? window.open("about:blank", "_blank") : null;
      const r = await invoke("gw-issue-token", { module_code: m.code });
      if (!r || !r.redirect_url) {
        if (win) win.close();
        return false;
      }
      if (win) {
        win.opener = null;
        win.location.href = r.redirect_url;
      } else {
        location.assign(r.redirect_url);
      }
      return true;
    }
    const record = sb.rpc("gw_record_open", { p_module: m.id });
    if (newTab) {
      window.open(m.url, "_blank", "noopener,noreferrer");
      await record;
    } else {
      await record;
      location.assign(m.url);
    }
    return true;
  }

  function setLocale(locale) {
    try {
      localStorage.setItem("gw_locale", locale);
    } catch (e) {
      /* 忽略 */
    }
  }

  return {
    sb,
    BASE,
    LOCALE,
    setLocale,
    t,
    esc,
    $,
    $$,
    icon,
    refreshIcons,
    fmtDateTime,
    go,
    applyTheme,
    loadProfile,
    requireProfile,
    logout,
    changePassword,
    shell,
    spinner,
    cls,
    btn,
    badge,
    alertBox,
    modal,
    confirmDialog,
    toast,
    invoke,
    downloadXlsx,
    downloadBlob,
    readXlsxRows,
    MODULE_ICONS,
    moduleIcon,
    openModule,
  };
})();
