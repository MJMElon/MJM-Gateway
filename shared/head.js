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
    "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.js",
    "https://cdn.jsdelivr.net/npm/lucide@0.469.0/dist/umd/lucide.min.js",
    base + "shared/config.js",
    base + "lang/en.js",
    base + "shared/core.js",
  ];
  // 样式是事先编译好的（shared/app.css）；改了画面的 class 之后执行 npm run build:css
  document.write('<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>');
  document.write('<link rel="stylesheet" href="' + base + 'shared/app.css">');
  libs.forEach((src) => document.write('<script src="' + src + '"><\/script>'));
})();
