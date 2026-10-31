-- =====================================================================
-- 主画面改成固定格子的棋盘：sort_order = 第几格（slot，从 0 开始）
-- 第一次登录自动排版时从第 0 格开始放（原本从 1 开始，会空一格）
-- 只改 gw_init_layout 函数。
-- =====================================================================
create or replace function public.gw_init_layout()
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

  -- 属于多个 Business：每个 Business 一个文件夹，放在前面几格
  if v_group_count > 1 then
    with ins as (
      insert into public.gw_user_folders (user_id, name, color, sort_order)
      select v_user, t.name, v_colors[1 + ((t.rn - 1) % array_length(v_colors, 1))], (t.rn - 1)::integer
      from gw_tmp_groups t
      returning id, name
    )
    insert into gw_tmp_folders
    select t.group_id, ins.id, t.rn
    from ins join gw_tmp_groups t on t.name = ins.name;
  end if;

  -- App：在文件夹里的按文件夹内顺序；不在文件夹的接在文件夹后面的格子
  insert into public.gw_user_layout (user_id, module_id, folder_id, sort_order)
  select v_user, e.module_id, f.folder_id,
         case
           when f.folder_id is not null then (row_number() over (partition by f.folder_id order by m.sort_order, m.name))::integer
           else v_group_count + (row_number() over (partition by (f.folder_id is null) order by m.sort_order, m.name))::integer - 1
         end
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
