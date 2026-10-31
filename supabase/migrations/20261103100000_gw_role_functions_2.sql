-- =====================================================================
-- 角色功能调整 ＋ Business 代码
--  - 「把人放进 Business」拆成：加人进 Business（can_add_business_user）、移出 Business（can_remove_business_user）
--  - 新增「看 User & Group Manage」（can_view_user_group）：看得到群组列表、模块权限（只能看，除非有其他功能）
--  - Business 加上代码（code），跟 Company 一样
-- 只动 gw_* 对象。
-- =====================================================================

alter table public.gw_roles rename column can_place_users to can_add_business_user;
alter table public.gw_roles
  add column can_remove_business_user boolean not null default false,
  add column can_view_user_group      boolean not null default false;
update public.gw_roles
set can_remove_business_user = can_add_business_user,
    can_view_user_group = (can_add_business_user or can_grant_module or can_revoke_module or can_set_module_admin);

alter table public.gw_groups
  add column code text unique check (code ~ '^[A-Z0-9][A-Z0-9_-]{1,19}$');

-- 有没有任何管理权
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
             or r.can_view_user_group or r.can_view_users or r.can_view_audit)
    )
    or exists (select 1 from public.gw_my_admin_module_ids())
$$;

-- 能否查看某用户
--  可以「加人进 Business」：全部（要找得到还没分配的人）
--  其他用户相关功能：只限角色负责的 Business 的人
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
    or public.gw__my_role_flag('can_add_business_user')
    or (
      (public.gw__my_role_flag('can_view_users') or public.gw__my_role_flag('can_view_user_group')
       or public.gw__my_role_flag('can_remove_business_user') or public.gw__my_role_flag('can_grant_module')
       or public.gw__my_role_flag('can_revoke_module') or public.gw__my_role_flag('can_set_module_admin'))
      and exists (
        select 1
        from public.gw_role_businesses rb
        join public.gw_group_members gm on gm.group_id = rb.group_id and gm.user_id = p_user
        where rb.role_id = public.gw_my_role_id()
      )
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

-- 加人进 Business（或换 Company）
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
      and public.gw__my_role_flag('can_add_business_user')
      and public.gw_manages_business(p_group)
      and not exists (select 1 from public.gw_profiles t where t.id = p_user and t.role = 'super_admin')
    )
$$;

-- 移出 Business
create function public.gw_can_remove_group_member(p_group uuid, p_user uuid)
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
      and public.gw__my_role_flag('can_remove_business_user')
      and public.gw_manages_business(p_group)
      and not exists (select 1 from public.gw_profiles t where t.id = p_user and t.role = 'super_admin')
    )
$$;
revoke execute on function public.gw_can_remove_group_member(uuid, uuid) from public, anon;
grant execute on function public.gw_can_remove_group_member(uuid, uuid) to authenticated;

drop policy if exists gw_group_members_delete on public.gw_group_members;
create policy gw_group_members_delete on public.gw_group_members
  for delete to authenticated
  using ((select public.gw_can_remove_group_member(group_id, user_id)));
