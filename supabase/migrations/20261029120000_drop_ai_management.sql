-- =====================================================================
-- 移除项目里已不再使用的「AI 管理」系统（ai_management_*）
-- 经项目负责人确认后执行。不影响 auth.users 里的登录帐号。
-- 保留 storage bucket「operation-reports」及其通用规则（不属于 AI 管理）。
-- =====================================================================

-- 先拆掉 auth.users 上的触发器，否则之后新增登录帐号会失败
drop trigger if exists ai_management_on_auth_user_created on auth.users;

drop table if exists
  public.ai_management_attachments,
  public.ai_management_comments,
  public.ai_management_time_sessions,
  public.ai_management_status_history,
  public.ai_management_proposals,
  public.ai_management_profiles
cascade;

drop function if exists public.ai_management_handle_new_user();
drop function if exists public.ai_management_my_department();

drop policy if exists "ai_mgmt read attachments" on storage.objects;
drop policy if exists "ai_mgmt upload attachments" on storage.objects;
