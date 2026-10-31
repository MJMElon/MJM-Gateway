-- =====================================================================
-- 1. 模块照片（gw_modules.image_url）＋ 公开的 storage bucket「module-icons」
-- 2. 个人连结图示（gw_user_links）：用户自己在主画面加的网址图示
-- 3. 角色功能：改模块名称（can_edit_module_name）、管理模块内的用户权限（can_manage_module_access）
--    有 can_manage_module_access 而且模块在角色范围内 → 等同那个模块的 Admin（模块内的 User Access 可以看、可以改）
-- 4. gw_rename_module：有权限的角色才能改模块名称 / 说明
-- 只新增；不删任何东西。
-- =====================================================================

alter table public.gw_modules add column image_url text check (char_length(image_url) <= 500);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('module-icons', 'module-icons', true, 2097152, array['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml'])
on conflict (id) do nothing;
create policy "module icons write" on storage.objects
  for all to authenticated
  using (bucket_id = 'module-icons' and (select public.gw_is_super_admin()))
  with check (bucket_id = 'module-icons' and (select public.gw_is_super_admin()));

-- 个人连结图示
create table public.gw_user_links (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.gw_profiles (id) on delete cascade,
  name        text not null check (char_length(btrim(name)) between 1 and 40),
  url         text not null check (url ~* '^https?://'),
  icon        text not null default 'link',
  image_url   text check (char_length(image_url) <= 500),
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);
create index gw_user_links_user_idx on public.gw_user_links (user_id);
alter table public.gw_user_links enable row level security;
revoke all on public.gw_user_links from anon;
create policy gw_user_links_own on public.gw_user_links
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- 角色功能
alter table public.gw_roles
  add column can_edit_module_name     boolean not null default false,
  add column can_manage_module_access boolean not null default false;

-- 角色对某模块有「管理模块内用户权限」
create function public.gw_role_manages_module_access(p_module uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.gw__my_role_flag('can_manage_module_access')
    and exists (select 1 from public.gw_role_modules rm where rm.role_id = public.gw_my_role_id() and rm.module_id = p_module)
$$;

-- 我是哪些模块的管理员：模块 Admin ＋ 角色有管理模块用户权限的模块
create or replace function public.gw_my_admin_module_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select mm.module_id
  from public.gw_module_members mm
  where mm.user_id = auth.uid() and mm.is_admin
    and mm.module_id in (select public.gw__effective_module_ids(auth.uid()))
  union
  select rm.module_id
  from public.gw_role_modules rm
  where rm.role_id = public.gw_my_role_id() and public.gw__my_role_flag('can_manage_module_access')
$$;

create or replace function public.gw_manages_any()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.gw_is_super_admin()
    or exists (
      select 1 from public.gw_roles r
      where r.id = public.gw_my_role_id()
        and (r.can_post_notice or r.can_delete_notice or r.can_grant_module or r.can_revoke_module
             or r.can_set_module_admin or r.can_add_business_user or r.can_remove_business_user
             or r.can_view_user_group or r.can_view_users or r.can_view_audit
             or r.can_edit_module_name or r.can_manage_module_access)
    )
    or exists (select 1 from public.gw_my_admin_module_ids())
$$;

-- 改模块名称 / 说明：super_admin，或角色有「改模块名称」而且模块在它的范围内
create function public.gw_rename_module(p_module uuid, p_name text, p_description text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (
    public.gw_is_super_admin()
    or (public.gw__my_role_flag('can_edit_module_name')
        and exists (select 1 from public.gw_role_modules rm where rm.role_id = public.gw_my_role_id() and rm.module_id = p_module))
  ) then
    raise exception 'gw: not allowed' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_name, ''))) = 0 then
    raise exception 'gw: name required' using errcode = '22023';
  end if;
  update public.gw_modules set name = btrim(p_name), description = nullif(btrim(coalesce(p_description, '')), '') where id = p_module;
end;
$$;

revoke execute on function public.gw_role_manages_module_access(uuid), public.gw_rename_module(uuid, text, text) from public, anon;
grant execute on function public.gw_role_manages_module_access(uuid), public.gw_rename_module(uuid, text, text) to authenticated;

-- 模块的 Company 标签：看得到模块的人都看得到（原本就是）；有改名权限的人看得到模块本身
drop policy if exists gw_modules_select on public.gw_modules;
create policy gw_modules_select on public.gw_modules
  for select to authenticated
  using (
    (select public.gw_is_super_admin())
    or id in (select public.gw_my_module_ids())
    or id in (select public.gw_my_managed_module_ids())
    or (
      (select public.gw__my_role_flag('can_edit_module_name'))
      and exists (select 1 from public.gw_role_modules rm where rm.role_id = (select public.gw_my_role_id()) and rm.module_id = gw_modules.id)
    )
  );
