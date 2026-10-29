-- =====================================================================
-- 首页小工具（iPhone 主画面那种 widget）
-- 每个用户自己的小工具：种类、大小、位置、设定（例如便条内容）。
-- 位置 sort_order 与 gw_user_layout（App）和 gw_user_folders（文件夹）共用同一个顺序。
-- 只新增 gw_* 对象。
-- =====================================================================

create table if not exists public.gw_user_widgets (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.gw_profiles (id) on delete cascade,
  widget_type  text not null check (widget_type in ('clock', 'greeting', 'announcements', 'recent', 'search', 'admin', 'notes', 'calendar')),
  size         text not null default 'medium' check (size in ('small', 'medium', 'large')),
  sort_order   integer not null default 0,
  config       jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists gw_user_widgets_user_idx on public.gw_user_widgets (user_id);

alter table public.gw_user_widgets enable row level security;
revoke all on public.gw_user_widgets from anon;

-- 只能看、改自己的小工具
drop policy if exists gw_user_widgets_own on public.gw_user_widgets;
create policy gw_user_widgets_own on public.gw_user_widgets
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- 一键重设首页：连小工具一起清掉，再按群组重排
create or replace function public.gw_reset_layout()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.gw_user_widgets where user_id = auth.uid();
  delete from public.gw_user_layout where user_id = auth.uid();
  delete from public.gw_user_folders where user_id = auth.uid();
  update public.gw_profiles set layout_initialized = false where id = auth.uid();
  perform public.gw_init_layout();
end;
$$;
