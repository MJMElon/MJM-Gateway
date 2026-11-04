-- 把这整个文件贴到 Supabase SQL Editor 一次执行（里面是 5 个新的数据库更新，按顺序）。
-- 都只是新增东西，不会改动或删除现有资料（只有最后一个会换掉一个小工具种类的检查清单）。

-- ============ 20261110100000_gw_link_folder ============
-- 个人连结图示（Add Icon）也可以放进主页的文件夹
-- 只新增一栏；文件夹被删除时，里面的连结回到主页（folder_id 变回空）。
alter table public.gw_user_links
  add column folder_id uuid references public.gw_user_folders (id) on delete set null;

-- ============ 20261111100000_gw_sectors ============
-- =====================================================================
-- Sector（部门性质，例如 Operation、Admin、Account）和每个「Business × 模块」的负责人
--  - gw_sectors：super_admin 自己新增 / 改名 / 删除的预设清单
--  - gw_group_modules 多两栏：sector_id（这个 Business 里，这个模块属于哪个 Sector）、
--    lead_user_id（这个模块在这个 Business 的主要负责人）
-- 只新增；删除 Sector 或用户时，模块上的这两栏自动变回空。
-- =====================================================================

create table public.gw_sectors (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 1 and 40),
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);
create unique index gw_sectors_name_uq on public.gw_sectors (lower(btrim(name)));

alter table public.gw_sectors enable row level security;
revoke all on public.gw_sectors from anon;

create policy gw_sectors_select on public.gw_sectors
  for select to authenticated using (true);
create policy gw_sectors_write on public.gw_sectors
  for all to authenticated
  using ((select public.gw_is_super_admin()))
  with check ((select public.gw_is_super_admin()));

create trigger gw_audit after insert or update or delete on public.gw_sectors
  for each row execute function public.gw_audit_row();

alter table public.gw_group_modules
  add column sector_id uuid references public.gw_sectors (id) on delete set null,
  add column lead_user_id uuid references public.gw_profiles (id) on delete set null;

-- ============ 20261112100000_gw_member_companies ============
-- =====================================================================
-- 一个人可以同时在同一个 Business 的好几个 Company 里
--  - gw_member_companies：每个人在每个 Business 里属于哪些 Company（一个人一个 Business 可以有多个）
--  - 原本 gw_group_members.company_id 只能记一个，现有的资料先搬过来；那一栏之后不再使用（保留，不删）
--  - 在 Business 里、但一个 Company 都没有 = 「Pending allocation to company」
--  - 权限和加人进 Business 一样：加 / 换用 can_add_business_user，移出 Company 用 can_remove_business_user（或加人的权限）
-- 只新增；gw_audit_row 多认得这张表。
-- =====================================================================

create table public.gw_member_companies (
  group_id    uuid not null,
  user_id     uuid not null,
  company_id  uuid not null,
  created_at  timestamptz not null default now(),
  primary key (group_id, user_id, company_id),
  foreign key (group_id, user_id) references public.gw_group_members (group_id, user_id) on delete cascade,
  foreign key (group_id, company_id) references public.gw_business_companies (group_id, company_id) on delete cascade
);
create index gw_member_companies_company_idx on public.gw_member_companies (company_id);
create index gw_member_companies_user_idx on public.gw_member_companies (user_id);

-- 现有的 Company 归属搬过来
insert into public.gw_member_companies (group_id, user_id, company_id)
select gm.group_id, gm.user_id, gm.company_id
from public.gw_group_members gm
where gm.company_id is not null
  and exists (select 1 from public.gw_business_companies bc where bc.group_id = gm.group_id and bc.company_id = gm.company_id)
on conflict do nothing;

alter table public.gw_member_companies enable row level security;
revoke all on public.gw_member_companies from anon;

create policy gw_member_companies_select on public.gw_member_companies
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.gw_can_view_user(user_id)));
create policy gw_member_companies_insert on public.gw_member_companies
  for insert to authenticated
  with check ((select public.gw_can_manage_group_member(group_id, user_id)));
create policy gw_member_companies_delete on public.gw_member_companies
  for delete to authenticated
  using ((select public.gw_can_manage_group_member(group_id, user_id)) or (select public.gw_can_remove_group_member(group_id, user_id)));

create or replace function public.gw_audit_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_after  jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_row    jsonb := coalesce(v_after, v_before);
  v_target text := substr(tg_table_name, 4); -- 去掉 gw_ 前缀
  v_id     text;
  v_label  text;
  v_noise  constant text[] := array['locale', 'theme', 'layout_initialized', 'updated_at'];
begin
  if tg_table_name = 'gw_profiles' and tg_op = 'UPDATE'
     and (v_before - v_noise) = (v_after - v_noise) then
    return null;
  end if;

  v_id := coalesce(
    v_row ->> 'id',
    case tg_table_name
      when 'gw_group_members' then (v_row ->> 'group_id') || ':' || (v_row ->> 'user_id')
      when 'gw_group_modules' then (v_row ->> 'group_id') || ':' || (v_row ->> 'module_id')
      when 'gw_module_members' then (v_row ->> 'user_id') || ':' || (v_row ->> 'module_id')
      when 'gw_role_businesses' then (v_row ->> 'role_id') || ':' || (v_row ->> 'group_id')
      when 'gw_role_modules' then (v_row ->> 'role_id') || ':' || (v_row ->> 'group_id') || ':' || (v_row ->> 'module_id')
      when 'gw_business_companies' then (v_row ->> 'group_id') || ':' || (v_row ->> 'company_id')
      when 'gw_module_companies' then (v_row ->> 'module_id') || ':' || (v_row ->> 'company_id')
      when 'gw_member_companies' then (v_row ->> 'group_id') || ':' || (v_row ->> 'user_id') || ':' || (v_row ->> 'company_id')
    end
  );
  v_label := case tg_table_name
    when 'gw_group_members' then
      (select g.name from public.gw_groups g where g.id = (v_row ->> 'group_id')::uuid) || ' → ' ||
      (select p.email from public.gw_profiles p where p.id = (v_row ->> 'user_id')::uuid)
    when 'gw_group_modules' then
      (select g.name from public.gw_groups g where g.id = (v_row ->> 'group_id')::uuid) || ' → ' ||
      (select m.code from public.gw_modules m where m.id = (v_row ->> 'module_id')::uuid)
    when 'gw_module_members' then
      (select m.code from public.gw_modules m where m.id = (v_row ->> 'module_id')::uuid) || ' → ' ||
      (select p.email from public.gw_profiles p where p.id = (v_row ->> 'user_id')::uuid) ||
      case when (v_row ->> 'is_admin')::boolean then ' (admin)' else '' end
    when 'gw_role_businesses' then
      (select r.name from public.gw_roles r where r.id = (v_row ->> 'role_id')::uuid) || ' → ' ||
      (select g.name from public.gw_groups g where g.id = (v_row ->> 'group_id')::uuid)
    when 'gw_role_modules' then
      (select r.name from public.gw_roles r where r.id = (v_row ->> 'role_id')::uuid) || ' → ' ||
      (select m.code from public.gw_modules m where m.id = (v_row ->> 'module_id')::uuid)
    when 'gw_business_companies' then
      (select g.name from public.gw_groups g where g.id = (v_row ->> 'group_id')::uuid) || ' → ' ||
      (select c.name from public.gw_companies c where c.id = (v_row ->> 'company_id')::uuid)
    when 'gw_module_companies' then
      (select m.code from public.gw_modules m where m.id = (v_row ->> 'module_id')::uuid) || ' → ' ||
      (select c.name from public.gw_companies c where c.id = (v_row ->> 'company_id')::uuid)
    when 'gw_member_companies' then
      (select p.email from public.gw_profiles p where p.id = (v_row ->> 'user_id')::uuid) || ' → ' ||
      (select g.name from public.gw_groups g where g.id = (v_row ->> 'group_id')::uuid) || ' · ' ||
      (select c.name from public.gw_companies c where c.id = (v_row ->> 'company_id')::uuid)
    when 'gw_company_mappings' then
      (select c.name from public.gw_companies c where c.id = (v_row ->> 'company_id')::uuid) || ' → ' ||
      (select m.code from public.gw_modules m where m.id = (v_row ->> 'module_id')::uuid) || ' ' || (v_row ->> 'external_id')
    else coalesce(v_row ->> 'code', v_row ->> 'email', v_row ->> 'name', left(v_row ->> 'message', 60))
  end;

  perform public.gw__write_audit(auth.uid(), lower(tg_op), v_target, v_id, v_label, v_before, v_after);
  return null;
end;
$$;

create trigger gw_audit after insert or update or delete on public.gw_member_companies
  for each row execute function public.gw_audit_row();

-- ============ 20261113100000_gw_notice_reactions ============
-- =====================================================================
-- Notice Board 的表情反应：👍（like）、❤️（love）、🎉（congrats）
--  - gw_notice_reactions：谁对哪一则公告按了哪个反应（每人每则每种最多一个）
--  - 看得到那则公告的人，才看得到它的反应、也才能按反应；只能改自己的
--  - gw_get_notice_reactions(ids)：一次拿多则公告的反应，附上按的人的名字（点反应时显示是谁按的）
-- 只新增。
-- =====================================================================

create table public.gw_notice_reactions (
  announcement_id  uuid not null references public.gw_announcements (id) on delete cascade,
  user_id          uuid not null references public.gw_profiles (id) on delete cascade,
  emoji            text not null check (emoji in ('like', 'love', 'congrats')),
  created_at       timestamptz not null default now(),
  primary key (announcement_id, user_id, emoji)
);
create index gw_notice_reactions_user_idx on public.gw_notice_reactions (user_id);

alter table public.gw_notice_reactions enable row level security;
revoke all on public.gw_notice_reactions from anon;

-- 看得到公告（公告自己的 RLS）就看得到它的反应
create policy gw_notice_reactions_select on public.gw_notice_reactions
  for select to authenticated
  using (exists (select 1 from public.gw_announcements a where a.id = announcement_id));
create policy gw_notice_reactions_insert on public.gw_notice_reactions
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.gw_announcements a where a.id = announcement_id)
  );
create policy gw_notice_reactions_delete on public.gw_notice_reactions
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- 名字：一般用户看不到别人的个人资料，所以用 definer 函数只取名字
create function public.gw__display_name(p_user uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.full_name from public.gw_profiles p where p.id = p_user
$$;

-- 用调用者的身份查（RLS 照常生效），所以只会拿到看得到的公告的反应
create function public.gw_get_notice_reactions(p_ids uuid[])
returns table (announcement_id uuid, emoji text, user_id uuid, full_name text)
language sql
stable
security invoker
set search_path = ''
as $$
  select r.announcement_id, r.emoji, r.user_id, public.gw__display_name(r.user_id)
  from public.gw_notice_reactions r
  where r.announcement_id = any (p_ids)
  order by r.created_at
$$;

revoke execute on function public.gw__display_name(uuid), public.gw_get_notice_reactions(uuid[]) from public, anon;
grant execute on function public.gw__display_name(uuid), public.gw_get_notice_reactions(uuid[]) to authenticated;

-- ============ 20261114100000_gw_widget_weather ============
-- 小工具多一种：weather（天气）
-- 只是把允许的小工具种类清单加一项；现有的小工具不受影响。
alter table public.gw_user_widgets drop constraint if exists gw_user_widgets_widget_type_check;
alter table public.gw_user_widgets
  add constraint gw_user_widgets_widget_type_check
  check (widget_type in ('clock', 'greeting', 'announcements', 'recent', 'search', 'admin', 'notes', 'calendar', 'weather'));
