-- =====================================================================
-- 角色功能（逐项勾选）＋ 范围（Business / 模块，沿用 gw_role_businesses / gw_role_modules）
--
-- 功能：
--   can_post_notice       更新 Notice Board（发布、修改公告）
--   can_delete_notice     删除 Notice Board 的公告
--   can_grant_module      把人加进模块（开 Access）
--   can_revoke_module     把人从模块移除（收回 Access）
--   can_set_module_admin  设定模块 Admin
--   can_place_users       把人放进 / 移出 Business（和 Company）
--   can_view_users        看用户名单（只限角色负责的 Business 的人）
--   can_view_audit        看操作记录
-- 公告和模块相关的功能只在角色负责的 Business / 模块内有效。
-- 没有角色的人 = 一般用户，没有任何管理权。
-- 只动 gw_* 对象。
-- =====================================================================

alter table public.gw_roles
  add column can_delete_notice    boolean not null default false,
  add column can_grant_module     boolean not null default false,
  add column can_revoke_module    boolean not null default false,
  add column can_set_module_admin boolean not null default false,
  add column can_place_users      boolean not null default false,
  add column can_view_users       boolean not null default false,
  add column can_view_audit       boolean not null default false;

-- 已经存在的角色：保留原本能做的事
update public.gw_roles
set can_delete_notice = can_post_notice,
    can_grant_module = true,
    can_revoke_module = true,
    can_set_module_admin = true,
    can_place_users = true,
    can_view_users = true;

-- 当前用户的角色有没有某项功能
create function public.gw__my_role_flag(p_flag text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select (to_jsonb(r) ->> p_flag)::boolean from public.gw_roles r where r.id = public.gw_my_role_id()), false)
$$;

-- 有没有任何管理权（右上角齿轮）：super_admin、角色有任何一项功能、模块 Admin
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
             or r.can_set_module_admin or r.can_place_users or r.can_view_users or r.can_view_audit)
    )
    or exists (select 1 from public.gw_my_admin_module_ids())
$$;

-- 能否查看某用户：
--  自己；super_admin；
--  可以「放人进 Business」的角色：全部（要找得到还没分配的人）；
--  有看名单 / 模块权限功能的角色：只限角色负责的 Business 的人；
--  模块 Admin：跟自己在同一个 Business 的人
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
    or public.gw__my_role_flag('can_place_users')
    or (
      (public.gw__my_role_flag('can_view_users') or public.gw__my_role_flag('can_grant_module')
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

-- 放人进 / 移出 Business：角色要有 can_place_users，而且是它负责的 Business
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
      and public.gw__my_role_flag('can_place_users')
      and public.gw_manages_business(p_group)
      and not exists (select 1 from public.gw_profiles t where t.id = p_user and t.role = 'super_admin')
    )
$$;

-- 模块管理员那条路（同一个有这个模块的 Business）
create function public.gw__module_admin_reaches(p_user uuid, p_module uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    p_module in (select public.gw_my_admin_module_ids())
    and exists (
      select 1
      from public.gw_group_members mine
      join public.gw_group_members theirs on theirs.group_id = mine.group_id and theirs.user_id = p_user
      join public.gw_group_modules gx on gx.group_id = mine.group_id and gx.module_id = p_module
      where mine.user_id = auth.uid()
    )
$$;

-- 把人加进模块（开 Access）
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
      and (
        (public.gw__my_role_flag('can_grant_module') and public.gw__role_manages_module(p_user, p_module))
        or public.gw__module_admin_reaches(p_user, p_module)
      )
    )
$$;

-- 把人从模块移除（收回 Access）
create function public.gw_can_revoke_module_member(p_user uuid, p_module uuid)
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
      and (
        (public.gw__my_role_flag('can_revoke_module') and public.gw__role_manages_module(p_user, p_module))
        or public.gw__module_admin_reaches(p_user, p_module)
      )
    )
$$;

-- 设定模块 Admin
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
      and public.gw__my_role_flag('can_set_module_admin')
      and public.gw__role_manages_module(p_user, p_module)
    )
$$;

-- 公告：更新（发布、修改）／删除，只限角色负责的 Business；全公司公告只有 super_admin
create function public.gw_can_delete_notice(p_group uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.gw_is_super_admin()
    or (p_group is not null and public.gw__my_role_flag('can_delete_notice') and public.gw_manages_business(p_group))
$$;
create or replace function public.gw_can_post_notice(p_group uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.gw_is_super_admin()
    or (p_group is not null and public.gw__my_role_flag('can_post_notice') and public.gw_manages_business(p_group))
$$;

revoke execute on function
  public.gw__my_role_flag(text), public.gw__module_admin_reaches(uuid, uuid),
  public.gw_can_revoke_module_member(uuid, uuid), public.gw_can_delete_notice(uuid)
from public, anon;
grant execute on function
  public.gw__my_role_flag(text), public.gw__module_admin_reaches(uuid, uuid),
  public.gw_can_revoke_module_member(uuid, uuid), public.gw_can_delete_notice(uuid)
to authenticated;

-- 模块成员：移除改用「收回」的权限
drop policy if exists gw_module_members_delete on public.gw_module_members;
create policy gw_module_members_delete on public.gw_module_members
  for delete to authenticated
  using (
    (select public.gw_can_revoke_module_member(user_id, module_id))
    and (not is_admin or (select public.gw_can_set_module_admin(user_id, module_id)))
  );

-- 公告：新增 / 修改 / 删除分开
drop policy if exists gw_announcements_write on public.gw_announcements;
drop policy if exists gw_announcements_select on public.gw_announcements;
create policy gw_announcements_select on public.gw_announcements
  for select to authenticated
  using (
    (select public.gw_is_super_admin())
    or (group_id is not null and ((select public.gw_can_post_notice(group_id)) or (select public.gw_can_delete_notice(group_id))))
    or (
      is_active
      and starts_at <= now()
      and (ends_at is null or ends_at > now())
      and (
        group_id is null
        or exists (
          select 1 from public.gw_group_members gm
          where gm.group_id = gw_announcements.group_id and gm.user_id = (select auth.uid())
        )
      )
    )
  );
create policy gw_announcements_insert on public.gw_announcements
  for insert to authenticated
  with check ((select public.gw_can_post_notice(group_id)));
create policy gw_announcements_update on public.gw_announcements
  for update to authenticated
  using ((select public.gw_can_post_notice(group_id)))
  with check ((select public.gw_can_post_notice(group_id)));
create policy gw_announcements_delete on public.gw_announcements
  for delete to authenticated
  using ((select public.gw_can_delete_notice(group_id)));

-- 操作记录：super_admin，或角色有「看操作记录」
drop policy if exists gw_audit_logs_select on public.gw_audit_logs;
create policy gw_audit_logs_select on public.gw_audit_logs
  for select to authenticated
  using ((select public.gw_is_super_admin()) or (select public.gw__my_role_flag('can_view_audit')));

-- 首页公告带上对象 Business 和发布人（Notice Board 上修改 / 删除用）
create or replace function public.gw_get_home(p_user uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user uuid := coalesce(p_user, auth.uid());
  v_result jsonb;
begin
  if v_user is null or not public.gw_can_view_user(v_user) then
    raise exception 'gw: not allowed' using errcode = '42501';
  end if;

  with eff as (
    select public.gw__effective_module_ids(v_user) as id
  )
  select jsonb_build_object(
    'profile', (
      select jsonb_build_object(
        'id', p.id, 'email', p.email, 'full_name', p.full_name, 'role', p.role,
        'status', p.status, 'layout_initialized', p.layout_initialized
      )
      from public.gw_profiles p
      where p.id = v_user
    ),
    'modules', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id, 'code', m.code, 'name', m.name, 'icon', m.icon, 'url', m.url,
        'description', m.description, 'category', m.category,
        'access_level', m.access_level, 'open_mode', m.open_mode,
        'is_new', not exists (
          select 1 from public.gw_user_module_seen s where s.user_id = v_user and s.module_id = m.id
        )
      ) order by m.sort_order, m.name)
      from public.gw_modules m
      where m.id in (select id from eff)
    ), '[]'::jsonb),
    'folders', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', f.id, 'name', f.name, 'color', f.color, 'sort_order', f.sort_order, 'collapsed', f.collapsed
      ) order by f.sort_order, f.created_at)
      from public.gw_user_folders f
      where f.user_id = v_user
    ), '[]'::jsonb),
    'layout', coalesce((
      select jsonb_agg(jsonb_build_object(
        'module_id', l.module_id, 'folder_id', l.folder_id, 'sort_order', l.sort_order, 'card_size', l.card_size
      ) order by l.sort_order)
      from public.gw_user_layout l
      where l.user_id = v_user and l.module_id in (select id from eff)
    ), '[]'::jsonb),
    'recent', coalesce((
      select jsonb_agg(r.module_id order by r.last_opened desc)
      from (
        select o.module_id, max(o.opened_at) as last_opened
        from public.gw_module_opens o
        where o.user_id = v_user and o.module_id in (select id from eff)
        group by o.module_id
        order by last_opened desc
        limit 5
      ) r
    ), '[]'::jsonb),
    'announcements', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'message', a.message, 'level', a.level, 'starts_at', a.starts_at,
        'group_id', a.group_id, 'created_by', a.created_by,
        'author', (select p.full_name from public.gw_profiles p where p.id = a.created_by)
      ) order by a.starts_at desc)
      from public.gw_announcements a
      where a.is_active
        and a.starts_at <= now()
        and (a.ends_at is null or a.ends_at > now())
        and (
          a.group_id is null
          or exists (select 1 from public.gw_group_members gm where gm.group_id = a.group_id and gm.user_id = v_user)
        )
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;
