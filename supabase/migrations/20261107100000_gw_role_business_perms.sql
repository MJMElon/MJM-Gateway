-- =====================================================================
-- 角色功能改成「按 Business」设定
--  - gw_role_businesses（角色 × Business）记这个角色在这个 Business 可以做什么：
--      can_post_notice / can_delete_notice      这个 Business 的公告栏
--      can_grant_module / can_revoke_module / can_set_module_admin   这个 Business 里所有模块
--      can_add_business_user / can_remove_business_user              把人放进 / 移出这个 Business
--      can_view_users                                                看这个 Business 的用户名单
--  - gw_roles 只留全域功能：can_view_user_group（有任何 Business 动作时自动算有）、can_view_audit、
--    can_edit_module_name、can_manage_module_access（范围 = 负责的 Business 里的模块）
--  - 不再按模块勾选（gw_role_modules 移除）；模块范围 = Business 里的所有模块
-- 线上目前没有自订角色。只动 gw_* 对象。
-- =====================================================================

alter table public.gw_role_businesses
  add column can_post_notice          boolean not null default false,
  add column can_delete_notice        boolean not null default false,
  add column can_grant_module         boolean not null default false,
  add column can_revoke_module        boolean not null default false,
  add column can_set_module_admin     boolean not null default false,
  add column can_add_business_user    boolean not null default false,
  add column can_remove_business_user boolean not null default false,
  add column can_view_users           boolean not null default false;

-- 既有角色：把原本全域的功能搬到它负责的每个 Business
update public.gw_role_businesses rb
set can_post_notice = r.can_post_notice,
    can_delete_notice = r.can_delete_notice,
    can_grant_module = r.can_grant_module,
    can_revoke_module = r.can_revoke_module,
    can_set_module_admin = r.can_set_module_admin,
    can_add_business_user = r.can_add_business_user,
    can_remove_business_user = r.can_remove_business_user,
    can_view_users = r.can_view_users
from public.gw_roles r
where r.id = rb.role_id;

-- 先拿掉用到 gw_role_modules 的 policy，再删表（最后面会重建 policy）
drop policy if exists gw_modules_select on public.gw_modules;
drop table if exists public.gw_role_modules;
alter table public.gw_roles
  drop column can_post_notice,
  drop column can_delete_notice,
  drop column can_grant_module,
  drop column can_revoke_module,
  drop column can_set_module_admin,
  drop column can_add_business_user,
  drop column can_remove_business_user,
  drop column can_view_users;

-- ---------------------------------------------------------------------
-- 函数
-- ---------------------------------------------------------------------
-- 当前角色在某个 Business 有没有某项功能
create function public.gw__my_biz_flag(p_group uuid, p_flag text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select (to_jsonb(rb) ->> p_flag)::boolean
    from public.gw_role_businesses rb
    where rb.role_id = public.gw_my_role_id() and rb.group_id = p_group
  ), false)
$$;
-- 在任何 Business 有某项功能
create function public.gw__my_any_biz_flag(p_flag text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.gw_role_businesses rb
    where rb.role_id = public.gw_my_role_id() and (to_jsonb(rb) ->> p_flag)::boolean
  )
$$;
-- 角色对某个人的某个模块有某项功能：对方在角色负责的 Business 里，而且那个 Business 有这个模块
create function public.gw__role_module_perm(p_user uuid, p_module uuid, p_flag text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.gw_role_businesses rb
    join public.gw_group_modules gx on gx.group_id = rb.group_id and gx.module_id = p_module
    join public.gw_group_members gm on gm.group_id = rb.group_id and gm.user_id = p_user
    where rb.role_id = public.gw_my_role_id() and (to_jsonb(rb) ->> p_flag)::boolean
  )
$$;

create or replace function public.gw_manages_business(p_group uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.gw_is_super_admin()
    or exists (select 1 from public.gw_role_businesses rb where rb.role_id = public.gw_my_role_id() and rb.group_id = p_group)
$$;

create or replace function public.gw_role_manages_module_access(p_module uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.gw__my_role_flag('can_manage_module_access')
    and exists (
      select 1 from public.gw_role_businesses rb
      join public.gw_group_modules gx on gx.group_id = rb.group_id and gx.module_id = p_module
      where rb.role_id = public.gw_my_role_id()
    )
$$;

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
  select gx.module_id
  from public.gw_role_businesses rb
  join public.gw_group_modules gx on gx.group_id = rb.group_id
  where rb.role_id = public.gw_my_role_id() and public.gw__my_role_flag('can_manage_module_access')
$$;

-- 我可以管理的模块：负责的 Business 里的模块（有加 / 移除 / 设定 Admin 任一）＋ 模块 Admin
create or replace function public.gw_my_managed_module_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select gx.module_id
  from public.gw_role_businesses rb
  join public.gw_group_modules gx on gx.group_id = rb.group_id
  where rb.role_id = public.gw_my_role_id()
    and (rb.can_grant_module or rb.can_revoke_module or rb.can_set_module_admin)
  union
  select public.gw_my_admin_module_ids()
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
      select 1 from public.gw_role_businesses rb
      where rb.role_id = public.gw_my_role_id()
        and (rb.can_post_notice or rb.can_delete_notice or rb.can_grant_module or rb.can_revoke_module
             or rb.can_set_module_admin or rb.can_add_business_user or rb.can_remove_business_user or rb.can_view_users)
    )
    or exists (
      select 1 from public.gw_roles r
      where r.id = public.gw_my_role_id()
        and (r.can_view_user_group or r.can_view_audit or r.can_edit_module_name or r.can_manage_module_access)
    )
    or exists (select 1 from public.gw_my_admin_module_ids())
$$;

create or replace function public.gw_can_view_user(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    p_user = auth.uid()
    or public.gw_is_super_admin()
    or public.gw__my_any_biz_flag('can_add_business_user')
    or exists (
      select 1
      from public.gw_role_businesses rb
      join public.gw_group_members gm on gm.group_id = rb.group_id and gm.user_id = p_user
      where rb.role_id = public.gw_my_role_id()
        and (rb.can_view_users or rb.can_remove_business_user or rb.can_grant_module or rb.can_revoke_module or rb.can_set_module_admin
             or public.gw__my_role_flag('can_view_user_group') or public.gw__my_role_flag('can_manage_module_access'))
    )
    or (
      exists (select 1 from public.gw_my_admin_module_ids())
      and exists (
        select 1
        from public.gw_group_members mine
        join public.gw_group_members theirs on theirs.group_id = mine.group_id and theirs.user_id = p_user
        where mine.user_id = auth.uid()
      )
    )
$$;

create or replace function public.gw_can_manage_group_member(p_group uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.gw_is_super_admin()
    or (
      p_user <> auth.uid()
      and public.gw__my_biz_flag(p_group, 'can_add_business_user')
      and not exists (select 1 from public.gw_profiles t where t.id = p_user and t.role = 'super_admin')
    )
$$;

create or replace function public.gw_can_remove_group_member(p_group uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.gw_is_super_admin()
    or (
      p_user <> auth.uid()
      and public.gw__my_biz_flag(p_group, 'can_remove_business_user')
      and not exists (select 1 from public.gw_profiles t where t.id = p_user and t.role = 'super_admin')
    )
$$;

create or replace function public.gw_can_manage_module_member(p_user uuid, p_module uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.gw_is_super_admin()
    or (
      p_user <> auth.uid()
      and not exists (select 1 from public.gw_profiles t where t.id = p_user and t.role = 'super_admin')
      and (public.gw__role_module_perm(p_user, p_module, 'can_grant_module') or public.gw__module_admin_reaches(p_user, p_module))
    )
$$;

create or replace function public.gw_can_revoke_module_member(p_user uuid, p_module uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.gw_is_super_admin()
    or (
      p_user <> auth.uid()
      and not exists (select 1 from public.gw_profiles t where t.id = p_user and t.role = 'super_admin')
      and (public.gw__role_module_perm(p_user, p_module, 'can_revoke_module') or public.gw__module_admin_reaches(p_user, p_module))
    )
$$;

create or replace function public.gw_can_set_module_admin(p_user uuid, p_module uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.gw_is_super_admin()
    or (
      p_user <> auth.uid()
      and not exists (select 1 from public.gw_profiles t where t.id = p_user and t.role = 'super_admin')
      and public.gw__role_module_perm(p_user, p_module, 'can_set_module_admin')
    )
$$;

create or replace function public.gw_can_post_notice(p_group uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.gw_is_super_admin() or (p_group is not null and public.gw__my_biz_flag(p_group, 'can_post_notice'))
$$;
create or replace function public.gw_can_delete_notice(p_group uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.gw_is_super_admin() or (p_group is not null and public.gw__my_biz_flag(p_group, 'can_delete_notice'))
$$;

create or replace function public.gw_rename_module(p_module uuid, p_name text, p_description text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (
    public.gw_is_super_admin()
    or (public.gw__my_role_flag('can_edit_module_name')
        and exists (
          select 1 from public.gw_role_businesses rb
          join public.gw_group_modules gx on gx.group_id = rb.group_id and gx.module_id = p_module
          where rb.role_id = public.gw_my_role_id()))
  ) then
    raise exception 'gw: not allowed' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_name, ''))) = 0 then
    raise exception 'gw: name required' using errcode = '22023';
  end if;
  update public.gw_modules set name = btrim(p_name), description = nullif(btrim(coalesce(p_description, '')), '') where id = p_module;
end;
$$;

drop function if exists public.gw__role_manages_module(uuid, uuid);

revoke execute on function public.gw__my_biz_flag(uuid, text), public.gw__my_any_biz_flag(text), public.gw__role_module_perm(uuid, uuid, text) from public, anon;
grant execute on function public.gw__my_biz_flag(uuid, text), public.gw__my_any_biz_flag(text), public.gw__role_module_perm(uuid, uuid, text) to authenticated;

-- 模块：看得到自己能用的、管得到的、负责的 Business 里的（有改名权限时）
drop policy if exists gw_modules_select on public.gw_modules;
create policy gw_modules_select on public.gw_modules
  for select to authenticated
  using (
    (select public.gw_is_super_admin())
    or id in (select public.gw_my_module_ids())
    or id in (select public.gw_my_managed_module_ids())
    or (
      (select public.gw__my_role_flag('can_edit_module_name'))
      and exists (
        select 1 from public.gw_role_businesses rb
        join public.gw_group_modules gx on gx.group_id = rb.group_id and gx.module_id = gw_modules.id
        where rb.role_id = (select public.gw_my_role_id())
      )
    )
  );
