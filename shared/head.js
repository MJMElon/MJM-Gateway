/* 每个页面 <head> 第一个载入：主题（避免闪烁）、Tailwind、共用函式库。
   函式库版本固定，升级时一次改这里。 */
(function () {
  try {
    const theme = localStorage.getItem("gw_theme") || "system";
    const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    if (dark) document.documentElement.classList.add("dark");
  } catch (e) {
    /* 忽略 */
  }

  const base = document.currentScript.src.replace(/shared\/head\.js.*$/, "");
  const libs = [
    "https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.1.11/dist/index.global.js",
    "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.js",
    "https://cdn.jsdelivr.net/npm/lucide@0.469.0/dist/umd/lucide.min.js",
    base + "shared/config.js",
    base + "lang/en.js",
    base + "shared/core.js",
  ];
  const theme = `
@custom-variant dark (&:where(.dark, .dark *));
@theme {
  --font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", sans-serif;
  --color-brand-50: #eef5ff;
  --color-brand-100: #d9e8ff;
  --color-brand-500: #2563eb;
  --color-brand-600: #1d4ed8;
  --color-brand-700: #1e40af;
}
@layer base {
  html { -webkit-tap-highlight-color: transparent; }
  body { @apply bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100 min-h-dvh; }
  [x-cloak] { display: none !important; }
}
.sortable-ghost { opacity: .35; }
.sortable-chosen { box-shadow: 0 10px 25px rgba(0,0,0,.15); }
body.gw-dragging .gw-folder-body { display: block !important; min-height: 3rem; }
/* 主画面背景 */
body.gw-wallpaper { background: radial-gradient(1200px 600px at 15% -10%, #e0ecff 0%, transparent 60%), radial-gradient(900px 500px at 100% 0%, #eef2f7 0%, transparent 55%), #f6f8fb; background-attachment: fixed; }
.dark body.gw-wallpaper { background: radial-gradient(1200px 600px at 15% -10%, #12233f 0%, transparent 60%), #020617; }
/* 编辑主画面时轻轻抖动（像 iPhone） */
@keyframes gw-jiggle { from { transform: rotate(-1.2deg); } to { transform: rotate(1.2deg); } }
.gw-editing > .gw-item { animation: gw-jiggle .14s ease-in-out infinite alternate; }
.gw-editing > .gw-item:nth-child(2n) { animation-delay: .07s; }
@media (prefers-reduced-motion: reduce) { .gw-editing > .gw-item { animation: none; } }
`;
  document.write('<style type="text/tailwindcss">' + theme + "</style>");
  libs.forEach((src) => document.write('<script src="' + src + '"><\/script>'));
})();
