-- =====================================================================
-- Gateway 权限：辅助函数 + RLS
-- 有效权限 = 所属群组的模块 ∪ 个人允许 − 个人禁止（禁止优先）
-- 帐号停用或模块下架 → 全部看不到
-- =====================================================================

-- ---------------------------------------------------------------------
-- 辅助函数（security definer：在 RLS 内部使用，避免递归）
-- ---------------------------------------------------------------------

-- 当前用户角色（停用帐号返回 null）
create function public.gw_my_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.role
  from public.gw_profiles p
  where p.id = auth.uid() and p.status = 'active'
$$;

create function public.gw_is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.gw_my_role() = 'super_admin', false)
$$;

-- 如果当前用户是启用中的部门 admin，返回其部门；否则 null
create function public.gw_my_admin_dept()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.department_id
  from public.gw_profiles p
  where p.id = auth.uid() and p.status = 'active' and p.role = 'admin'
$$;

-- 能否查看某用户（预览首页、看资料）
create function public.gw_can_view_user(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    p_user = auth.uid()
    or public.gw_is_super_admin()
    or exists (
      select 1 from public.gw_profiles t
      where t.id = p_user
        and t.department_id is not null
        and t.department_id = public.gw_my_admin_dept()
    )
$$;

-- 能否管理某用户：super_admin 可管所有人；admin 只能管本部门的一般用户，且不能管自己
create function public.gw_can_manage_user(p_user uuid)
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
      and exists (
        select 1 from public.gw_profiles t
        where t.id = p_user
          and t.role = 'user'
          and t.department_id is not null
          and t.department_id = public.gw_my_admin_dept()
      )
    )
$$;

-- 能否管理某群组的成员
create function public.gw_can_manage_group_member(p_group uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.gw_is_super_admin()
    or (
      public.gw_can_manage_user(p_user)
      and exists (
        select 1 from public.gw_groups g
        where g.id = p_group
          and g.department_id is not null
          and g.department_id = public.gw_my_admin_dept()
      )
    )
$$;

-- 能否给某群组开关某模块
-- admin：只限本部门群组 + 本部门模块，而且自己不能是该群组成员（不能给自己加权限）
create function public.gw_can_manage_group_module(p_group uuid, p_module uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.gw_is_super_admin()
    or (
      public.gw_my_admin_dept() is not null
      and exists (
        select 1 from public.gw_groups g
        where g.id = p_group and g.department_id = public.gw_my_admin_dept()
      )
      and exists (
        select 1 from public.gw_modules m
        where m.id = p_module and m.department_id = public.gw_my_admin_dept()
      )
      and not exists (
        select 1 from public.gw_group_members gm
        where gm.group_id = p_group and gm.user_id = auth.uid()
      )
    )
$$;

-- 能否设定某用户对某模块的个人例外
create function public.gw_can_manage_override(p_user uuid, p_module uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.gw_is_super_admin()
    or (
      public.gw_can_manage_user(p_user)
      and exists (
        select 1 from public.gw_modules m
        where m.id = p_module and m.department_id = public.gw_my_admin_dept()
      )
    )
$$;

-- 内部：某用户的有效模块（不做调用者检查，不开放给客户端）
create function public.gw__effective_module_ids(p_user uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.id
  from public.gw_modules m
  join public.gw_profiles p on p.id = p_user and p.status = 'active'
  where m.is_active
    and (
      exists (
        select 1
        from public.gw_group_modules gmod
        join public.gw_group_members gmem on gmem.group_id = gmod.group_id
        where gmod.module_id = m.id and gmem.user_id = p_user
      )
      or exists (
        select 1 from public.gw_user_module_overrides o
        where o.user_id = p_user and o.module_id = m.id and o.effect = 'allow'
      )
    )
    and not exists (
      select 1 from public.gw_user_module_overrides o
      where o.user_id = p_user and o.module_id = m.id and o.effect = 'deny'
    )
$$;

-- 当前用户的有效模块（RLS 使用）
create function public.gw_my_module_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select public.gw__effective_module_ids(auth.uid())
$$;

-- 某用户能否使用某模块（Edge Function / 目标系统查询用）
-- 调用者只能查自己、可查看的用户；service_role 可查任何人
create function public.gw_user_can_access(p_user uuid, p_module_code text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    (auth.role() = 'service_role' or public.gw_can_view_user(p_user))
    and exists (
      select 1 from public.gw_modules m
      where m.code = p_module_code
        and m.id in (select public.gw__effective_module_ids(p_user))
    )
$$;

-- ---------------------------------------------------------------------
-- gw_profiles 栏位保护：
--  - 一般用户（含 admin 改自己）只能改语言、主题、首页初始化、改密码标记
--  - admin 管理本部门用户时不能改角色、不能把人移出本部门
--  - super_admin 不能改自己的角色或停用自己（避免把自己锁在外面）
-- ---------------------------------------------------------------------
create function public.gw_profiles_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_self_cols constant text[] := array['locale', 'theme', 'layout_initialized', 'must_change_password', 'updated_at'];
begin
  -- service_role / 数据库维护直接放行
  if auth.uid() is null or auth.role() = 'service_role' then
    return new;
  end if;

  if new.id <> old.id or lower(new.email) <> lower(old.email) then
    raise exception 'gw: id/email cannot be changed here' using errcode = '42501';
  end if;

  if public.gw_is_super_admin() then
    if old.id = auth.uid() and (new.role <> old.role or new.status <> old.status) then
      raise exception 'gw: super_admin cannot change own role or status' using errcode = '42501';
    end if;
    return new;
  end if;

  if old.id = auth.uid() then
    if (to_jsonb(new) - v_self_cols) <> (to_jsonb(old) - v_self_cols) then
      raise exception 'gw: you can only change your own preferences' using errcode = '42501';
    end if;
    return new;
  end if;

  -- 部门 admin 管理本部门用户
  if new.role <> old.role or new.department_id is distinct from old.department_id then
    raise exception 'gw: admin cannot change role or department' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger gw_profiles_guard before update on public.gw_profiles
  for each row execute function public.gw_profiles_guard();

-- ---------------------------------------------------------------------
-- 权限收紧：匿名用户不能碰 gw_ 表；函数默认不开放
-- ---------------------------------------------------------------------
revoke all on
  public.gw_departments, public.gw_profiles, public.gw_groups, public.gw_group_members,
  public.gw_modules, public.gw_group_modules, public.gw_user_module_overrides,
  public.gw_user_folders, public.gw_user_layout, public.gw_module_opens,
  public.gw_user_module_seen, public.gw_announcements, public.gw_login_attempts,
  public.gw_module_api_keys, public.gw_audit_logs
from anon;

-- 只有 service_role 能读写
revoke all on public.gw_login_attempts, public.gw_module_api_keys from authenticated;

revoke execute on function
  public.gw_my_role(), public.gw_is_super_admin(), public.gw_my_admin_dept(),
  public.gw_can_view_user(uuid), public.gw_can_manage_user(uuid),
  public.gw_can_manage_group_member(uuid, uuid), public.gw_can_manage_group_module(uuid, uuid),
  public.gw_can_manage_override(uuid, uuid), public.gw__effective_module_ids(uuid),
  public.gw_my_module_ids(), public.gw_user_can_access(uuid, text),
  public.gw_profiles_guard(), public.gw_touch_updated_at()
from public, anon;

revoke execute on function public.gw__effective_module_ids(uuid) from authenticated;

grant execute on function
  public.gw_my_role(), public.gw_is_super_admin(), public.gw_my_admin_dept(),
  public.gw_can_view_user(uuid), public.gw_can_manage_user(uuid),
  public.gw_can_manage_group_member(uuid, uuid), public.gw_can_manage_group_module(uuid, uuid),
  public.gw_can_manage_override(uuid, uuid), public.gw_my_module_ids(),
  public.gw_user_can_access(uuid, text)
to authenticated;

grant execute on function public.gw__effective_module_ids(uuid), public.gw_user_can_access(uuid, text)
to service_role;

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------
alter table public.gw_departments            enable row level security;
alter table public.gw_profiles               enable row level security;
alter table public.gw_groups                 enable row level security;
alter table public.gw_group_members          enable row level security;
alter table public.gw_modules                enable row level security;
alter table public.gw_group_modules          enable row level security;
alter table public.gw_user_module_overrides  enable row level security;
alter table public.gw_user_folders           enable row level security;
alter table public.gw_user_layout            enable row level security;
alter table public.gw_module_opens           enable row level security;
alter table public.gw_user_module_seen       enable row level security;
alter table public.gw_announcements          enable row level security;
alter table public.gw_login_attempts         enable row level security;
alter table public.gw_module_api_keys        enable row level security;
alter table public.gw_audit_logs             enable row level security;

-- 部门：所有已登录用户可读；只有 super_admin 可写
create policy gw_departments_select on public.gw_departments
  for select to authenticated using (true);
create policy gw_departments_write on public.gw_departments
  for all to authenticated
  using ((select public.gw_is_super_admin()))
  with check ((select public.gw_is_super_admin()));

-- 用户资料
create policy gw_profiles_select on public.gw_profiles
  for select to authenticated
  using ((select public.gw_can_view_user(id)));
create policy gw_profiles_insert on public.gw_profiles
  for insert to authenticated
  with check (
    (select public.gw_is_super_admin())
    or (
      role = 'user'
      and department_id is not null
      and department_id = (select public.gw_my_admin_dept())
    )
  );
create policy gw_profiles_update on public.gw_profiles
  for update to authenticated
  using (id = (select auth.uid()) or (select public.gw_can_manage_user(id)))
  with check (id = (select auth.uid()) or (select public.gw_can_manage_user(id)));
-- 不提供 delete：帐号用「停用」

-- 群组：super_admin 管理；admin 可看本部门群组；用户可看自己所属群组
create policy gw_groups_select on public.gw_groups
  for select to authenticated
  using (
    (select public.gw_is_super_admin())
    or (department_id is not null and department_id = (select public.gw_my_admin_dept()))
    or exists (
      select 1 from public.gw_group_members gm
      where gm.group_id = gw_groups.id and gm.user_id = (select auth.uid())
    )
  );
create policy gw_groups_write on public.gw_groups
  for all to authenticated
  using ((select public.gw_is_super_admin()))
  with check ((select public.gw_is_super_admin()));

-- 群组成员
create policy gw_group_members_select on public.gw_group_members
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.gw_can_view_user(user_id)));
create policy gw_group_members_insert on public.gw_group_members
  for insert to authenticated
  with check ((select public.gw_can_manage_group_member(group_id, user_id)));
create policy gw_group_members_delete on public.gw_group_members
  for delete to authenticated
  using ((select public.gw_can_manage_group_member(group_id, user_id)));

-- 模块：没有权限的模块连名字都看不到
create policy gw_modules_select on public.gw_modules
  for select to authenticated
  using (
    (select public.gw_is_super_admin())
    or id in (select public.gw_my_module_ids())
    or (department_id is not null and department_id = (select public.gw_my_admin_dept()))
  );
create policy gw_modules_write on public.gw_modules
  for all to authenticated
  using ((select public.gw_is_super_admin()))
  with check ((select public.gw_is_super_admin()));

-- 群组 × 模块
create policy gw_group_modules_select on public.gw_group_modules
  for select to authenticated
  using (
    (select public.gw_is_super_admin())
    or exists (
      select 1 from public.gw_group_members gm
      where gm.group_id = gw_group_modules.group_id and gm.user_id = (select auth.uid())
    )
    or exists (
      select 1 from public.gw_groups g
      where g.id = group_id
        and g.department_id is not null
        and g.department_id = (select public.gw_my_admin_dept())
    )
  );
create policy gw_group_modules_insert on public.gw_group_modules
  for insert to authenticated
  with check ((select public.gw_can_manage_group_module(group_id, module_id)));
create policy gw_group_modules_delete on public.gw_group_modules
  for delete to authenticated
  using ((select public.gw_can_manage_group_module(group_id, module_id)));

-- 个人例外
create policy gw_overrides_select on public.gw_user_module_overrides
  for select to authenticated
  using ((select public.gw_is_super_admin()) or (select public.gw_can_manage_user(user_id)));
create policy gw_overrides_insert on public.gw_user_module_overrides
  for insert to authenticated
  with check ((select public.gw_can_manage_override(user_id, module_id)));
create policy gw_overrides_update on public.gw_user_module_overrides
  for update to authenticated
  using ((select public.gw_can_manage_override(user_id, module_id)))
  with check ((select public.gw_can_manage_override(user_id, module_id)));
create policy gw_overrides_delete on public.gw_user_module_overrides
  for delete to authenticated
  using ((select public.gw_can_manage_override(user_id, module_id)));

-- 文件夹：只能动自己的
create policy gw_user_folders_own on public.gw_user_folders
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- 版面：只能动自己的；新增时模块必须有权限
create policy gw_user_layout_select on public.gw_user_layout
  for select to authenticated using (user_id = (select auth.uid()));
create policy gw_user_layout_insert on public.gw_user_layout
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and module_id in (select public.gw_my_module_ids())
  );
create policy gw_user_layout_update on public.gw_user_layout
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy gw_user_layout_delete on public.gw_user_layout
  for delete to authenticated using (user_id = (select auth.uid()));

-- 最近打开 / 已看过：只读自己的；写入经由 RPC
create policy gw_module_opens_select on public.gw_module_opens
  for select to authenticated using (user_id = (select auth.uid()));
create policy gw_user_module_seen_select on public.gw_user_module_seen
  for select to authenticated using (user_id = (select auth.uid()));

-- 公告
create policy gw_announcements_select on public.gw_announcements
  for select to authenticated
  using (
    (select public.gw_is_super_admin())
    or (department_id is not null and department_id = (select public.gw_my_admin_dept()))
    or (
      is_active
      and starts_at <= now()
      and (ends_at is null or ends_at > now())
      and (
        department_id is null
        or department_id = (select p.department_id from public.gw_profiles p where p.id = (select auth.uid()))
      )
    )
  );
create policy gw_announcements_write on public.gw_announcements
  for all to authenticated
  using (
    (select public.gw_is_super_admin())
    or (department_id is not null and department_id = (select public.gw_my_admin_dept()))
  )
  with check (
    (select public.gw_is_super_admin())
    or (department_id is not null and department_id = (select public.gw_my_admin_dept()))
  );

-- gw_login_attempts / gw_module_api_keys：没有任何 policy = 客户端完全不能访问
