-- =====================================================================
-- Gateway 操作记录：自动记录权限相关改动；记录不能修改、不能删除
-- =====================================================================

-- 写一笔记录（内部用）
create function public.gw__write_audit(
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
  v_dept uuid;
begin
  if p_actor is not null then
    select p.email, p.department_id into v_email, v_dept
    from public.gw_profiles p where p.id = p_actor;
    if v_email is null then
      select u.email into v_email from auth.users u where u.id = p_actor;
    end if;
  end if;

  insert into public.gw_audit_logs
    (actor_id, actor_email, department_id, action, target_type, target_id, target_label, before_data, after_data)
  values
    (p_actor, v_email, v_dept, p_action, p_target_type, p_target_id, p_target_label, p_before, p_after);
end;
$$;

-- 服务端（service_role）记录登录、重设密码、建立用户等 Auth 事件
create function public.gw_log_event(
  p_actor uuid,
  p_action text,
  p_target_type text,
  p_target_id text default null,
  p_target_label text default null,
  p_after jsonb default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'gw: service_role only' using errcode = '42501';
  end if;
  perform public.gw__write_audit(p_actor, p_action, p_target_type, p_target_id, p_target_label, null, p_after);
end;
$$;

-- 资料表改动的自动记录
create function public.gw_audit_row()
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
  -- 个人偏好（语言、主题、首页初始化）不算权限操作，不记录
  if tg_table_name = 'gw_profiles' and tg_op = 'UPDATE'
     and (v_before - v_noise) = (v_after - v_noise) then
    return null;
  end if;

  v_id := coalesce(
    v_row ->> 'id',
    case tg_table_name
      when 'gw_group_members' then (v_row ->> 'group_id') || ':' || (v_row ->> 'user_id')
      when 'gw_group_modules' then (v_row ->> 'group_id') || ':' || (v_row ->> 'module_id')
      when 'gw_user_module_overrides' then (v_row ->> 'user_id') || ':' || (v_row ->> 'module_id')
    end
  );
  v_label := case tg_table_name
    when 'gw_group_members' then
      (select g.name from public.gw_groups g where g.id = (v_row ->> 'group_id')::uuid) || ' → ' ||
      (select p.email from public.gw_profiles p where p.id = (v_row ->> 'user_id')::uuid)
    when 'gw_group_modules' then
      (select g.name from public.gw_groups g where g.id = (v_row ->> 'group_id')::uuid) || ' → ' ||
      (select m.code from public.gw_modules m where m.id = (v_row ->> 'module_id')::uuid)
    when 'gw_user_module_overrides' then
      (select p.email from public.gw_profiles p where p.id = (v_row ->> 'user_id')::uuid) || ' → ' ||
      (select m.code from public.gw_modules m where m.id = (v_row ->> 'module_id')::uuid) || ' (' || (v_row ->> 'effect') || ')'
    else coalesce(v_row ->> 'code', v_row ->> 'email', v_row ->> 'name', left(v_row ->> 'message', 60))
  end;

  perform public.gw__write_audit(auth.uid(), lower(tg_op), v_target, v_id, v_label, v_before, v_after);
  return null;
end;
$$;

create trigger gw_audit after insert or update or delete on public.gw_profiles
  for each row execute function public.gw_audit_row();
create trigger gw_audit after insert or update or delete on public.gw_departments
  for each row execute function public.gw_audit_row();
create trigger gw_audit after insert or update or delete on public.gw_groups
  for each row execute function public.gw_audit_row();
create trigger gw_audit after insert or update or delete on public.gw_group_members
  for each row execute function public.gw_audit_row();
create trigger gw_audit after insert or update or delete on public.gw_modules
  for each row execute function public.gw_audit_row();
create trigger gw_audit after insert or update or delete on public.gw_group_modules
  for each row execute function public.gw_audit_row();
create trigger gw_audit after insert or update or delete on public.gw_user_module_overrides
  for each row execute function public.gw_audit_row();
create trigger gw_audit after insert or update or delete on public.gw_announcements
  for each row execute function public.gw_audit_row();

-- 记录不能改、不能删（连 service_role 也不行）
create function public.gw_audit_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'gw: audit logs are append-only' using errcode = '42501';
end;
$$;

create trigger gw_audit_logs_no_update before update or delete on public.gw_audit_logs
  for each row execute function public.gw_audit_immutable();
create trigger gw_audit_logs_no_truncate before truncate on public.gw_audit_logs
  for each statement execute function public.gw_audit_immutable();

revoke insert, update, delete, truncate on public.gw_audit_logs from authenticated, service_role;

-- 读取：super_admin 看全部；admin 看本部门人员的操作
create policy gw_audit_logs_select on public.gw_audit_logs
  for select to authenticated
  using (
    (select public.gw_is_super_admin())
    or (department_id is not null and department_id = (select public.gw_my_admin_dept()))
  );

revoke execute on function
  public.gw__write_audit(uuid, text, text, text, text, jsonb, jsonb),
  public.gw_log_event(uuid, text, text, text, text, jsonb),
  public.gw_audit_row(), public.gw_audit_immutable()
from public, anon, authenticated;
grant execute on function public.gw_log_event(uuid, text, text, text, text, jsonb) to service_role;
