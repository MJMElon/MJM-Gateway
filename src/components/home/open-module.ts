"use client";

import { createClient } from "@/lib/supabase/client";
import type { HomeModule } from "@/lib/types";

// 打开模块：
//  - 第 1 级（外部链接）/ 第 3 级（SSO）：直接打开网址
//  - 第 2 级（Token 跳转）：向 Edge Function 申请 60 秒 Token，再带着 Token 跳转
export async function openModule(module: HomeModule): Promise<{ ok: boolean; error?: string }> {
  const supabase = createClient();
  const newTab = module.open_mode === "new_tab";

  if (module.access_level === 2) {
    // 先同步开分页，避免被浏览器当成弹窗拦截
    const win = newTab ? window.open("about:blank", "_blank") : null;
    const { data, error } = await supabase.functions.invoke<{ redirect_url: string }>("gw-issue-token", {
      body: { module_code: module.code },
    });
    if (error || !data?.redirect_url) {
      win?.close();
      return { ok: false, error: "token" };
    }
    if (win) {
      win.opener = null;
      win.location.href = data.redirect_url;
    } else {
      window.location.assign(data.redirect_url);
    }
    return { ok: true };
  }

  const record = supabase.rpc("gw_record_open", { p_module: module.id });
  if (newTab) {
    window.open(module.url, "_blank", "noopener,noreferrer");
    await record;
  } else {
    await record;
    window.location.assign(module.url);
  }
  return { ok: true };
}
