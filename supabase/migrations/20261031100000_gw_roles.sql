-- =====================================================================
-- 自订角色（Role）＋ 逐个模块开权限；移除部门
--
-- 新的权限模型：
--  - Business（gw_groups）底下有模块（gw_group_modules = 这个 Business 有哪些模块）。
--  - 用户在 Business 里「有机会」用这些模块，但一开始看不到；
--    要有人把某个模块开给他（gw_module_members），才看得到。
--    每个模块对每个人有两个勾：Access（可以用）、Admin（这个模块的管理员，一定也有 Access）。
--    模块管理员可以把这个模块开给 / 收回同一个 Business 里的人，但不能设定别人当模块管理员。
--    有效模块 = 开给他的模块 ∩ 他所属 Business 的模块（模块要启用、帐号要启用）。
--  - 角色由 super_admin 自己命名（例如 HR、Admin），并设定：
--      · 管哪些 Business（gw_role_businesses）：可以把人放进 / 移出这些 Business（和 Company）
--      · 管这些 Business 里的哪些模块（gw_role_modules）：可以把这些模块开给 / 收回这个 Business 里的人
--      · 能不能在 Notice Board 发公告（can_post_notice）：公告只给他管的 Business 的人看
--  - gw_profiles.role 只剩 super_admin / user；自订角色记在 gw_profiles.role_id。
--  - 建立用户、改资料、重设密码、停用、设定角色、主资料：只有 super_admin。
--  - 部门（gw_departments）和个人例外（gw_user_module_overrides）不再使用，移除。
--
-- 线上这些表目前都没有资料（部门 0、个人例外 0、公告 0、只有 super_admin 一个用户）。
-- 只动 gw_* 对象。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. 先拿掉用到「部门 / 个人例外」的 policy 和函数
-- ---------------------------------------------------------------------
drop policy if exists gw_profiles_insert on public.gw_profiles;
drop policy if exists gw_profiles_update on public.gw_profiles;
drop policy if exists gw_groups_select on public.gw_groups;
drop policy if exists gw_modules_select on public.gw_modules;
drop policy if exists gw_group_modules_select on public.gw_group_modules;
drop policy if exists gw_group_modules_insert on public.gw_group_modules;
drop policy if exists gw_group_modules_delete on public.gw_group_modules;
drop policy if exists gw_announcements_select on public.gw_announcements;
drop policy if exists gw_announcements_write on public.gw_announcements;
drop policy if exists gw_audit_logs_select on public.gw_audit_logs;

drop table if exists public.gw_user_module_overrides;

drop function if exists public.gw_can_manage_group_module(uuid, uuid);
drop function if exists public.gw_can_manage_override(uuid, uuid);

-- ---------------------------------------------------------------------
-- 2. 新表
-- ---------------------------------------------------------------------
create table public.gw_roles (
  id               uuid primary key default gen_random_uuid(),
  name             text not null unique check (char_length(btrim(name)) between 1 and 60),
  description      text,
  can_post_notice  boolean not null default false,
  sort_order       integer not null default 0,
  created_at       timestamptz not null default now()
);

-- 角色管哪些 Business
create table public.gw_role_businesses (
  role_id     uuid not null references public.gw_roles (id) on delete cascade,
  group_id    uuid not null references public.gw_groups (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (role_id, group_id)
);

-- 角色管这些 Business 里的哪些模块（Business 要先勾，模块要属于这个 Business）
create table public.gw_role_modules (
  role_id     uuid not null,
  group_id    uuid not null,
  module_id   uuid not null,
  created_at  timestamptz not null default now(),
  primary key (role_id, group_id, module_id),
  foreign key (role_id, group_id) references public.gw_role_businesses (role_id, group_id) on delete cascade,
  foreign key (group_id, module_id) references public.gw_group_modules (group_id, module_id) on delete cascade
);
create index gw_role_modules_module_idx on public.gw_role_modules (module_id);

-- 逐个模块开给用户；is_admin = 这个模块的管理员（有这一行就一定有 Access）
create table public.gw_module_members (
  user_id     uuid not null references public.gw_profiles (id) on delete cascade,
  module_id   uuid not null references public.gw_modules (id) on delete cascade,
  is_admin    boolean not null default false,
  created_at  timestamptz not null default now(),
  primary key (user_id, module_id)
);
create index gw_module_members_module_idx on public.gw_module_members (module_id);

-- ---------------------------------------------------------------------
-- 3. 用户角色：super_admin / user ＋ 自订角色
-- ---------------------------------------------------------------------
update public.gw_profiles set role = 'user' where role = 'admin';
alter table public.gw_profiles drop constraint if exists gw_profiles_role_check;
alter table public.gw_profiles add constraint gw_profiles_role_check check (role in ('super_admin', 'user'));
alter table public.gw_profiles add column role_id uuid references public.gw_roles (id) on delete set null;
create index gw_profiles_role_idx on public.gw_profiles (role_id);

-- 公告对象：null = 全公司（只有 super_admin 能发），否则 = 某个 Business 的人
alter table public.gw_announcements add column group_id uuid references public.gw_groups (id) on delete cascade;
create index gw_announcements_group_idx on public.gw_announcements (group_id);

-- ---------------------------------------------------------------------
-- 4. 辅助函数
-- ---------------------------------------------------------------------

-- 当前用户的自订角色（停用帐号 / super_admin 返回 null）
create function public.gw_my_role_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.role_id
  from public.gw_profiles p
  where p.id = auth.uid() and p.status = 'active' and p.role = 'user'
$$;

-- 能否管理某个 Business 的成员
create function public.gw_manages_business(p_group uuid)
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
      where rb.role_id = public.gw_my_role_id() and rb.group_id = p_group
    )
$$;

-- 我是哪些模块的管理员（帐号要启用、而且这个模块对我有效）
create function public.gw_my_admin_module_ids()
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
$$;

-- 有没有任何管理权（决定右上角齿轮、能不能看到用户名单）
create function public.gw_manages_any()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.gw_is_super_admin()
    or exists (select 1 from public.gw_role_businesses rb where rb.role_id = public.gw_my_role_id())
    or exists (select 1 from public.gw_my_admin_module_ids())
$$;

-- 能否查看某用户：自己、super_admin、有管理权的人（要看得到名单才能把人拉进 Business）
create or replace function public.gw_can_view_user(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user = auth.uid() or public.gw_manages_any()
$$;

-- 能否改某用户的资料、停用、重设密码、设定角色：只有 super_admin
create or replace function public.gw_can_manage_user(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.gw_is_super_admin()
$$;

-- 能否把某人放进 / 移出某个 Business（或换 Company）
-- 角色：只限他管的 Business；不能动自己，也不能动 super_admin
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
      and public.gw_manages_business(p_group)
      and not exists (select 1 from public.gw_profiles t where t.id = p_user and t.role = 'super_admin')
    )
$$;

-- 角色那条路：这个模块在我的角色设定里，而且对方属于对应的 Business
create function public.gw__role_manages_module(p_user uuid, p_module uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.gw_role_modules rm
    join public.gw_group_members gm on gm.group_id = rm.group_id and gm.user_id = p_user
    where rm.role_id = public.gw_my_role_id() and rm.module_id = p_module
  )
$$;

-- 能否把某模块开给 / 收回某人（Access）
--  super_admin；角色（见上）；或这个模块的管理员（对方和我在同一个有这个模块的 Business）
--  不能动自己，也不能动 super_admin
create function public.gw_can_manage_module_member(p_user uuid, p_module uuid)
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
        public.gw__role_manages_module(p_user, p_module)
        or (
          p_module in (select public.gw_my_admin_module_ids())
          and exists (
            select 1
            from public.gw_group_members mine
            join public.gw_group_members theirs on theirs.group_id = mine.group_id and theirs.user_id = p_user
            join public.gw_group_modules gx on gx.group_id = mine.group_id and gx.module_id = p_module
            where mine.user_id = auth.uid()
          )
        )
      )
    )
$$;

-- 能否设定某人为模块管理员：super_admin 或角色（模块管理员不能再指定别人当管理员）
create function public.gw_can_set_module_admin(p_user uuid, p_module uuid)
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
      and public.gw__role_manages_module(p_user, p_module)
    )
$$;

-- 当前用户可以管理的模块：角色设定的 ＋ 自己是模块管理员的
create function public.gw_my_managed_module_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select rm.module_id from public.gw_role_modules rm where rm.role_id = public.gw_my_role_id()
  union
  select public.gw_my_admin_module_ids()
$$;

-- 能否发公告给某个 Business（null = 全公司，只有 super_admin）
create function public.gw_can_post_notice(p_group uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.gw_is_super_admin()
    or (
      p_group is not null
      and exists (
        select 1
        from public.gw_roles r
        join public.gw_role_businesses rb on rb.role_id = r.id
        where r.id = public.gw_my_role_id() and r.can_post_notice and rb.group_id = p_group
      )
    )
$$;

-- 有效模块：开给他的模块，而且他所属的某个 Business 有这个模块
create or replace function public.gw__effective_module_ids(p_user uuid)
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
    and exists (
      select 1 from public.gw_module_members mm
      where mm.user_id = p_user and mm.module_id = m.id
    )
    and exists (
      select 1
      from public.gw_group_members gm
      join public.gw_group_modules gx on gx.group_id = gm.group_id
      where gm.user_id = p_user and gx.module_id = m.id
    )
$$;

-- 资料栏位保护：一般用户只能改自己的偏好；super_admin 不能改自己的角色或停用自己
create or replace function public.gw_profiles_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_self_cols constant text[] := array['locale', 'theme', 'layout_initialized', 'must_change_password', 'updated_at'];
begin
  if auth.uid() is null or auth.role() = 'service_role' then
    return new;
  end if;

  if new.id <> old.id or lower(new.email) <> lower(old.email) then
    raise exception 'gw: id/email cannot be changed here' using errcode = '42501';
  end if;

  if public.gw_is_super_admin() then
    if old.id = auth.uid() and (new.role <> old.role or new.status <> old.status or new.role_id is distinct from old.role_id) then
      raise exception 'gw: super_admin cannot change own role or status' using errcode = '42501';
    end if;
    return new;
  end if;

  if old.id = auth.uid() and (to_jsonb(new) - v_self_cols) = (to_jsonb(old) - v_self_cols) then
    return new;
  end if;
  raise exception 'gw: you can only change your own preferences' using errcode = '42501';
end;
$$;

-- 被移出 Business 时：他已经不属于任何有这个模块的 Business 的话，收回该模块
create function public.gw_member_cleanup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.gw_module_members mm
  where mm.user_id = old.user_id
    and not exists (
      select 1
      from public.gw_group_members gm
      join public.gw_group_modules gx on gx.group_id = gm.group_id
      where gm.user_id = old.user_id and gx.module_id = mm.module_id
    );
  return null;
end;
$$;
create trigger gw_member_cleanup after delete on public.gw_group_members
  for each row execute function public.gw_member_cleanup();

-- 模块从 Business 拿掉时：同样收回不再有资格的人
create function public.gw_group_module_cleanup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.gw_module_members mm
  where mm.module_id = old.module_id
    and not exists (
      select 1
      from public.gw_group_members gm
      join public.gw_group_modules gx on gx.group_id = gm.group_id
      where gm.user_id = mm.user_id and gx.module_id = mm.module_id
    );
  return null;
end;
$$;
create trigger gw_group_module_cleanup after delete on public.gw_group_modules
  for each row execute function public.gw_group_module_cleanup();

-- ---------------------------------------------------------------------
-- 5. 移除部门
-- ---------------------------------------------------------------------
drop function if exists public.gw_my_admin_dept();
alter table public.gw_profiles drop column if exists department_id;
alter table public.gw_groups drop column if exists department_id;
alter table public.gw_modules drop column if exists department_id;
alter table public.gw_announcements drop column if exists department_id;
drop table if exists public.gw_departments;

-- 操作记录不再记部门（旧栏位保留，永远是 null）
create or replace function public.gw__write_audit(
  p_actor uuid,
  p_action text,
  p_target_type text,
  p_target_id text,
  p_target_label text,
  p_before jsonb,
  p_after jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
begin
  if p_actor is not null then
    select p.email into v_email from public.gw_profiles p where p.id = p_actor;
    if v_email is null then
      select u.email into v_email from auth.users u where u.id = p_actor;
    end if;
  end if;

  insert into public.gw_audit_logs
    (actor_id, actor_email, action, target_type, target_id, target_label, before_data, after_data)
  values
    (p_actor, v_email, p_action, p_target_type, p_target_id, p_target_label, p_before, p_after);
end;
$$;

-- 自动记录：加上新表的易读标签
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
    else coalesce(v_row ->> 'code', v_row ->> 'email', v_row ->> 'name', left(v_row ->> 'message', 60))
  end;

  perform public.gw__write_audit(auth.uid(), lower(tg_op), v_target, v_id, v_label, v_before, v_after);
  return null;
end;
$$;

create trigger gw_audit after insert or update or delete on public.gw_roles
  for each row execute function public.gw_audit_row();
create trigger gw_audit after insert or update or delete on public.gw_role_businesses
  for each row execute function public.gw_audit_row();
create trigger gw_audit after insert or update or delete on public.gw_role_modules
  for each row execute function public.gw_audit_row();
create trigger gw_audit after insert or update or delete on public.gw_module_members
  for each row execute function public.gw_audit_row();

-- 首页资料：公告改按 Business
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
      select jsonb_agg(jsonb_build_object('id', a.id, 'message', a.message, 'level', a.level, 'starts_at', a.starts_at)
        order by a.starts_at desc)
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

-- 权限矩阵 / 用户名单上显示的有效模块
create or replace function public.gw_admin_effective(p_users uuid[])
returns table (user_id uuid, module_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select u, e
  from unnest(p_users) as u
  cross join lateral public.gw__effective_module_ids(u) as e
  where public.gw_can_view_user(u)
    and (public.gw_is_super_admin() or e in (select public.gw_my_managed_module_ids()))
$$;

-- ---------------------------------------------------------------------
-- 6. 函数权限
-- ---------------------------------------------------------------------
revoke execute on function
  public.gw_my_role_id(), public.gw_manages_business(uuid), public.gw_manages_any(),
  public.gw_can_manage_module_member(uuid, uuid), public.gw_my_managed_module_ids(),
  public.gw_my_admin_module_ids(), public.gw__role_manages_module(uuid, uuid), public.gw_can_set_module_admin(uuid, uuid),
  public.gw_can_post_notice(uuid), public.gw_member_cleanup(), public.gw_group_module_cleanup()
from public, anon;
grant execute on function
  public.gw_my_role_id(), public.gw_manages_business(uuid), public.gw_manages_any(),
  public.gw_can_manage_module_member(uuid, uuid), public.gw_my_managed_module_ids(),
  public.gw_my_admin_module_ids(), public.gw__role_manages_module(uuid, uuid), public.gw_can_set_module_admin(uuid, uuid),
  public.gw_can_post_notice(uuid)
to authenticated;
revoke execute on function public.gw_member_cleanup(), public.gw_group_module_cleanup() from authenticated;

-- ---------------------------------------------------------------------
-- 7. RLS
-- ---------------------------------------------------------------------
alter table public.gw_roles            enable row level security;
alter table public.gw_role_businesses  enable row level security;
alter table public.gw_role_modules     enable row level security;
alter table public.gw_module_members   enable row level security;
revoke all on public.gw_roles, public.gw_role_businesses, public.gw_role_modules, public.gw_module_members from anon;

-- 用户资料：只有 super_admin 新增、改别人；自己可以改偏好
create policy gw_profiles_insert on public.gw_profiles
  for insert to authenticated
  with check ((select public.gw_is_super_admin()));
create policy gw_profiles_update on public.gw_profiles
  for update to authenticated
  using (id = (select auth.uid()) or (select public.gw_is_super_admin()))
  with check (id = (select auth.uid()) or (select public.gw_is_super_admin()));

-- Business：super_admin、成员、管这个 Business 的角色看得到
create policy gw_groups_select on public.gw_groups
  for select to authenticated
  using (
    (select public.gw_manages_business(id))
    or exists (
      select 1 from public.gw_group_members gm
      where gm.group_id = gw_groups.id and gm.user_id = (select auth.uid())
    )
  );

-- 模块：自己能用的、角色管得到的；super_admin 全部
create policy gw_modules_select on public.gw_modules
  for select to authenticated
  using (
    (select public.gw_is_super_admin())
    or id in (select public.gw_my_module_ids())
    or id in (select public.gw_my_managed_module_ids())
  );

-- Business 有哪些模块：super_admin 设定
create policy gw_group_modules_select on public.gw_group_modules
  for select to authenticated
  using (
    (select public.gw_manages_business(group_id))
    or exists (
      select 1 from public.gw_group_members gm
      where gm.group_id = gw_group_modules.group_id and gm.user_id = (select auth.uid())
    )
  );
create policy gw_group_modules_write on public.gw_group_modules
  for all to authenticated
  using ((select public.gw_is_super_admin()))
  with check ((select public.gw_is_super_admin()));

-- 模块开给谁
create policy gw_module_members_select on public.gw_module_members
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or (select public.gw_is_super_admin())
    or module_id in (select public.gw_my_managed_module_ids())
  );
-- 开 Access：可以管理这个模块的人；同时勾 Admin 要有设定管理员的权限
create policy gw_module_members_insert on public.gw_module_members
  for insert to authenticated
  with check (
    (select public.gw_can_manage_module_member(user_id, module_id))
    and (not is_admin or (select public.gw_can_set_module_admin(user_id, module_id)))
  );
-- 改 Admin 勾：只有 super_admin / 角色
create policy gw_module_members_update on public.gw_module_members
  for update to authenticated
  using ((select public.gw_can_set_module_admin(user_id, module_id)))
  with check ((select public.gw_can_set_module_admin(user_id, module_id)));
-- 收回 Access：模块管理员不能收回另一个管理员
create policy gw_module_members_delete on public.gw_module_members
  for delete to authenticated
  using (
    (select public.gw_can_manage_module_member(user_id, module_id))
    and (not is_admin or (select public.gw_can_set_module_admin(user_id, module_id)))
  );

-- 角色：super_admin 设定；每个人看得到自己的角色设定
create policy gw_roles_select on public.gw_roles
  for select to authenticated
  using ((select public.gw_is_super_admin()) or id = (select public.gw_my_role_id()));
create policy gw_roles_write on public.gw_roles
  for all to authenticated
  using ((select public.gw_is_super_admin()))
  with check ((select public.gw_is_super_admin()));
create policy gw_role_businesses_select on public.gw_role_businesses
  for select to authenticated
  using ((select public.gw_is_super_admin()) or role_id = (select public.gw_my_role_id()));
create policy gw_role_businesses_write on public.gw_role_businesses
  for all to authenticated
  using ((select public.gw_is_super_admin()))
  with check ((select public.gw_is_super_admin()));
create policy gw_role_modules_select on public.gw_role_modules
  for select to authenticated
  using ((select public.gw_is_super_admin()) or role_id = (select public.gw_my_role_id()));
create policy gw_role_modules_write on public.gw_role_modules
  for all to authenticated
  using ((select public.gw_is_super_admin()))
  with check ((select public.gw_is_super_admin()));

-- 公告：生效中的给对象看；发公告的人（super_admin / 可发公告的角色）看得到、管得到自己 Business 的
create policy gw_announcements_select on public.gw_announcements
  for select to authenticated
  using (
    (select public.gw_is_super_admin())
    or (group_id is not null and (select public.gw_can_post_notice(group_id)))
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
create policy gw_announcements_write on public.gw_announcements
  for all to authenticated
  using ((select public.gw_can_post_notice(group_id)))
  with check ((select public.gw_can_post_notice(group_id)));

-- 操作记录：只有 super_admin
create policy gw_audit_logs_select on public.gw_audit_logs
  for select to authenticated
  using ((select public.gw_is_super_admin()));
