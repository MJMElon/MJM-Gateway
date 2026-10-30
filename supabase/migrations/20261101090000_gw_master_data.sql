-- =====================================================================
-- 主资料：Company 独立出来（可以属于多个 Business）、Company 代码、
--         对应到现有系统（mapping）、Icon 类型与标签
--
--  - gw_companies 不再挂在某一个 Business 底下；改用 gw_business_companies 连结（多对多）
--    成员放进某个 Business 的某个 Company：那个 Company 必须连结到这个 Business
--  - Company 加上 code（固定不变，对应其他系统用）、简称、注册号码、启用状态
--  - gw_company_mappings：每个 Company 在每个现有系统（Icon）里的 ID / 代码
--  - gw_modules（画面上叫 Icon）加上 kind：
--      system = MJM Connect 旗下的系统（例如 Diesel，同一个网站、同一个资料库）
--      link   = 连到现有系统或任何外部网站
--  - Icon 的标签：Business（gw_group_modules，已有）＋ Company（gw_module_companies，新）
--
-- 线上 gw_companies 目前没有资料。只动 gw_* 对象。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Company 独立 + 多对多
-- ---------------------------------------------------------------------
create table public.gw_business_companies (
  group_id    uuid not null references public.gw_groups (id) on delete cascade,
  company_id  uuid not null references public.gw_companies (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (group_id, company_id)
);
create index gw_business_companies_company_idx on public.gw_business_companies (company_id);

-- 原本挂在某个 Business 的 Company，搬成连结
insert into public.gw_business_companies (group_id, company_id)
select group_id, id from public.gw_companies
on conflict do nothing;

-- 成员的 Company 必须连结到他所在的 Business
alter table public.gw_group_members drop constraint if exists gw_group_members_company_fk;
alter table public.gw_group_members
  add constraint gw_group_members_company_fk
  foreign key (group_id, company_id) references public.gw_business_companies (group_id, company_id)
  on delete set null (company_id);

drop policy if exists gw_companies_select on public.gw_companies;
alter table public.gw_companies drop constraint if exists gw_companies_group_id_name_key;
alter table public.gw_companies drop constraint if exists gw_companies_id_group_id_key;
drop index if exists public.gw_companies_group_idx;
alter table public.gw_companies drop column if exists group_id;

alter table public.gw_companies
  add column code text unique check (code ~ '^[A-Z0-9][A-Z0-9_-]{1,19}$'),
  add column short_name text check (char_length(short_name) <= 40),
  add column registration_no text check (char_length(registration_no) <= 40),
  add column is_active boolean not null default true,
  add constraint gw_companies_name_key unique (name);

-- ---------------------------------------------------------------------
-- 2. Company 对应到现有系统
-- ---------------------------------------------------------------------
create table public.gw_company_mappings (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.gw_companies (id) on delete cascade,
  module_id      uuid not null references public.gw_modules (id) on delete cascade,
  external_id    text not null check (char_length(btrim(external_id)) between 1 and 100),
  external_name  text check (char_length(external_name) <= 120),
  notes          text check (char_length(notes) <= 300),
  created_at     timestamptz not null default now(),
  unique (module_id, external_id)
);
create index gw_company_mappings_company_idx on public.gw_company_mappings (company_id);

-- ---------------------------------------------------------------------
-- 3. Icon 类型、Company 标签
-- ---------------------------------------------------------------------
alter table public.gw_modules
  add column kind text not null default 'link' check (kind in ('system', 'link'));

create table public.gw_module_companies (
  module_id   uuid not null references public.gw_modules (id) on delete cascade,
  company_id  uuid not null references public.gw_companies (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (module_id, company_id)
);
create index gw_module_companies_company_idx on public.gw_module_companies (company_id);

-- ---------------------------------------------------------------------
-- 4. RLS：主资料所有登录的人都可以读（名称、代码），只有 super_admin 可以改
--    对应表只给 super_admin 和有管理权的人看
-- ---------------------------------------------------------------------
alter table public.gw_business_companies enable row level security;
alter table public.gw_company_mappings enable row level security;
alter table public.gw_module_companies enable row level security;
revoke all on public.gw_business_companies, public.gw_company_mappings, public.gw_module_companies from anon;

create policy gw_companies_select on public.gw_companies
  for select to authenticated using (true);

create policy gw_business_companies_select on public.gw_business_companies
  for select to authenticated using (true);
create policy gw_business_companies_write on public.gw_business_companies
  for all to authenticated
  using ((select public.gw_is_super_admin()))
  with check ((select public.gw_is_super_admin()));

create policy gw_company_mappings_select on public.gw_company_mappings
  for select to authenticated using ((select public.gw_manages_any()));
create policy gw_company_mappings_write on public.gw_company_mappings
  for all to authenticated
  using ((select public.gw_is_super_admin()))
  with check ((select public.gw_is_super_admin()));

-- Icon 的 Company 标签：看得到这个 Icon 的人才看得到
create policy gw_module_companies_select on public.gw_module_companies
  for select to authenticated
  using (exists (select 1 from public.gw_modules m where m.id = module_id));
create policy gw_module_companies_write on public.gw_module_companies
  for all to authenticated
  using ((select public.gw_is_super_admin()))
  with check ((select public.gw_is_super_admin()));

-- ---------------------------------------------------------------------
-- 5. 操作记录
-- ---------------------------------------------------------------------
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
    when 'gw_company_mappings' then
      (select c.name from public.gw_companies c where c.id = (v_row ->> 'company_id')::uuid) || ' → ' ||
      (select m.code from public.gw_modules m where m.id = (v_row ->> 'module_id')::uuid) || ' ' || (v_row ->> 'external_id')
    else coalesce(v_row ->> 'code', v_row ->> 'email', v_row ->> 'name', left(v_row ->> 'message', 60))
  end;

  perform public.gw__write_audit(auth.uid(), lower(tg_op), v_target, v_id, v_label, v_before, v_after);
  return null;
end;
$$;

create trigger gw_audit after insert or update or delete on public.gw_business_companies
  for each row execute function public.gw_audit_row();
create trigger gw_audit after insert or update or delete on public.gw_company_mappings
  for each row execute function public.gw_audit_row();
create trigger gw_audit after insert or update or delete on public.gw_module_companies
  for each row execute function public.gw_audit_row();
