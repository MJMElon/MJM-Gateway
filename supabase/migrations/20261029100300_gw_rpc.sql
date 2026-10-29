-- =====================================================================
-- Gateway RPC：首页、版面、最近打开、登录锁定
-- =====================================================================

-- ---------------------------------------------------------------------
-- 首页资料（自己，或 admin「以此人身份预览」）
-- 版面只回传目前有权限的模块；没权限的版面记录保留但不显示
-- ---------------------------------------------------------------------
create function public.gw_get_home(p_user uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user uuid := coalesce(p_user, auth.uid());
  v_dept uuid;
  v_result jsonb;
begin
  if v_user is null or not public.gw_can_view_user(v_user) then
    raise exception 'gw: not allowed' using errcode = '42501';
  end if;

  select p.department_id into v_dept from public.gw_profiles p where p.id = v_user;

  with eff as (
    select public.gw__effective_module_ids(v_user) as id
  )
  select jsonb_build_object(
    'profile', (
      select jsonb_build_object(
        'id', p.id, 'email', p.email, 'full_name', p.full_name, 'role', p.role,
        'status', p.status, 'layout_initialized', p.layout_initialized,
        'department', d.name
      )
      from public.gw_profiles p
      left join public.gw_departments d on d.id = p.department_id
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
      select jsonb_agg(jsonb_build_object('id', a.id, 'message', a.message, 'level', a.level)
        order by a.starts_at desc)
      from public.gw_announcements a
      where a.is_active
        and a.starts_at <= now()
        and (a.ends_at is null or a.ends_at > now())
        and (a.department_id is null or a.department_id = v_dept)
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------
-- 第一次登录：按群组自动排好预设版面
--  - 属于多个群组：每个群组建一个文件夹，模块放进第一个包含它的群组文件夹
--  - 只属于一个群组：全部放在未分类
--  - 个人允许的模块放在未分类
-- ---------------------------------------------------------------------
create function public.gw_init_layout()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_initialized boolean;
  v_colors constant text[] := array['blue', 'green', 'amber', 'purple', 'rose', 'teal', 'slate'];
  v_group_count integer;
begin
  select p.layout_initialized into v_initialized
  from public.gw_profiles p
  where p.id = v_user and p.status = 'active'
  for update;

  if v_initialized is null or v_initialized then
    return;
  end if;

  drop table if exists gw_tmp_eff, gw_tmp_groups, gw_tmp_folders;

  create temporary table gw_tmp_eff on commit drop as
    select public.gw__effective_module_ids(v_user) as module_id;

  create temporary table gw_tmp_groups on commit drop as
    select g.id as group_id, g.name,
           row_number() over (order by g.sort_order, g.name) as rn
    from public.gw_groups g
    join public.gw_group_members gm on gm.group_id = g.id and gm.user_id = v_user
    where exists (
      select 1 from public.gw_group_modules gmod
      where gmod.group_id = g.id and gmod.module_id in (select module_id from gw_tmp_eff)
    );

  select count(*) into v_group_count from gw_tmp_groups;

  create temporary table gw_tmp_folders (group_id uuid, folder_id uuid, rn bigint) on commit drop;

  if v_group_count > 1 then
    with ins as (
      insert into public.gw_user_folders (user_id, name, color, sort_order)
      select v_user, t.name, v_colors[1 + ((t.rn - 1) % array_length(v_colors, 1))], t.rn::integer
      from gw_tmp_groups t
      returning id, name
    )
    insert into gw_tmp_folders
    select t.group_id, ins.id, t.rn
    from ins join gw_tmp_groups t on t.name = ins.name;
  end if;

  insert into public.gw_user_layout (user_id, module_id, folder_id, sort_order)
  select v_user, e.module_id, f.folder_id,
         (row_number() over (order by f.rn nulls last, m.sort_order, m.name))::integer
  from gw_tmp_eff e
  join public.gw_modules m on m.id = e.module_id
  left join lateral (
    select tf.folder_id, tf.rn
    from gw_tmp_folders tf
    join public.gw_group_modules gmod on gmod.group_id = tf.group_id and gmod.module_id = e.module_id
    order by tf.rn
    limit 1
  ) f on true
  on conflict (user_id, module_id) do nothing;

  insert into public.gw_user_module_seen (user_id, module_id)
  select v_user, module_id from gw_tmp_eff
  on conflict do nothing;

  update public.gw_profiles set layout_initialized = true where id = v_user;
end;
$$;

-- 一键重设首页
create function public.gw_reset_layout()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.gw_user_layout where user_id = auth.uid();
  delete from public.gw_user_folders where user_id = auth.uid();
  update public.gw_profiles set layout_initialized = false where id = auth.uid();
  perform public.gw_init_layout();
end;
$$;

-- 批量保存版面（security invoker：RLS 照常检查，新加入的模块必须有权限）
create function public.gw_save_layout(p_items jsonb)
returns void
language sql
security invoker
set search_path = ''
as $$
  insert into public.gw_user_layout (user_id, module_id, folder_id, sort_order, card_size)
  select auth.uid(), i.module_id, i.folder_id, i.sort_order, coalesce(i.card_size, 'large')
  from jsonb_to_recordset(p_items) as i(module_id uuid, folder_id uuid, sort_order integer, card_size text)
  on conflict (user_id, module_id) do update
    set folder_id = excluded.folder_id,
        sort_order = excluded.sort_order,
        card_size = excluded.card_size;
$$;

-- 记录打开模块（最近打开）；同时标记为已看过
create function public.gw_record_open(p_module uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_module not in (select public.gw_my_module_ids()) then
    raise exception 'gw: no access to module' using errcode = '42501';
  end if;

  insert into public.gw_module_opens (user_id, module_id) values (auth.uid(), p_module);
  insert into public.gw_user_module_seen (user_id, module_id) values (auth.uid(), p_module)
  on conflict do nothing;

  -- 只保留最近 90 天
  delete from public.gw_module_opens
  where user_id = auth.uid() and opened_at < now() - interval '90 days';
end;
$$;

-- 标记为已看过（去掉 NEW）
create function public.gw_mark_seen(p_modules uuid[])
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.gw_user_module_seen (user_id, module_id)
  select auth.uid(), m
  from unnest(p_modules) as m
  where m in (select public.gw_my_module_ids())
  on conflict do nothing;
$$;

-- ---------------------------------------------------------------------
-- 登录锁定：连续输错 5 次锁 15 分钟（只给服务端 service_role 用）
-- ---------------------------------------------------------------------
create function public.gw_login_locked_until(p_email text)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select a.locked_until
  from public.gw_login_attempts a
  where a.email = lower(trim(p_email)) and a.locked_until > now()
$$;

create function public.gw_login_failed(p_email text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(trim(p_email));
  v_row public.gw_login_attempts;
begin
  insert into public.gw_login_attempts as a (email, failed_count, updated_at)
  values (v_email, 1, now())
  on conflict (email) do update
    set failed_count = case
          when a.locked_until is not null and a.locked_until <= now() then 1
          else a.failed_count + 1
        end,
        locked_until = case
          when a.locked_until is not null and a.locked_until <= now() then null
          else a.locked_until
        end,
        updated_at = now()
  returning * into v_row;

  if v_row.failed_count >= 5 then
    update public.gw_login_attempts
      set locked_until = now() + interval '15 minutes', failed_count = 0
      where email = v_email
      returning * into v_row;
  end if;

  return jsonb_build_object(
    'failed_count', v_row.failed_count,
    'remaining', greatest(0, 5 - v_row.failed_count),
    'locked_until', v_row.locked_until
  );
end;
$$;

create function public.gw_login_succeeded(p_email text)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.gw_login_attempts where email = lower(trim(p_email));
$$;

-- ---------------------------------------------------------------------
-- 函数权限
-- ---------------------------------------------------------------------
revoke execute on function
  public.gw_get_home(uuid), public.gw_init_layout(), public.gw_reset_layout(),
  public.gw_save_layout(jsonb), public.gw_record_open(uuid), public.gw_mark_seen(uuid[]),
  public.gw_login_locked_until(text), public.gw_login_failed(text), public.gw_login_succeeded(text)
from public, anon;

grant execute on function
  public.gw_get_home(uuid), public.gw_init_layout(), public.gw_reset_layout(),
  public.gw_save_layout(jsonb), public.gw_record_open(uuid), public.gw_mark_seen(uuid[])
to authenticated;

revoke execute on function
  public.gw_login_locked_until(text), public.gw_login_failed(text), public.gw_login_succeeded(text)
from authenticated;
grant execute on function
  public.gw_login_locked_until(text), public.gw_login_failed(text), public.gw_login_succeeded(text)
to service_role;

-- ---------------------------------------------------------------------
-- 后台用
-- ---------------------------------------------------------------------

-- 权限矩阵：某些用户的有效模块（只回传调用者看得到的用户与模块）
create function public.gw_admin_effective(p_users uuid[])
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
    and (
      public.gw_is_super_admin()
      or e in (select public.gw_my_module_ids())
      or exists (
        select 1 from public.gw_modules m
        where m.id = e and m.department_id is not null and m.department_id = public.gw_my_admin_dept()
      )
    )
$$;

-- 建立用户时，如果 email 已经有 Supabase 帐号（例如 machinery 门户的用户），找出它来连结
create function public.gw_auth_user_id(p_email text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select u.id from auth.users u where lower(u.email) = lower(trim(p_email)) limit 1
$$;

revoke execute on function public.gw_admin_effective(uuid[]), public.gw_auth_user_id(text) from public, anon;
grant execute on function public.gw_admin_effective(uuid[]) to authenticated;
revoke execute on function public.gw_auth_user_id(text) from authenticated;
grant execute on function public.gw_auth_user_id(text) to service_role;
