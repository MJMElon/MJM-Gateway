-- =====================================================================
-- Business → Company
-- 群组（gw_groups）在画面上叫 Business；每个 Business 底下可以有多个 Company。
-- 用户拖进某个 Business 底下的某个 Company：gw_group_members 多记一个 company_id。
-- 模块权限仍然按 Business（群组）计算，不变。
-- 只新增 gw_* 对象，不删除任何资料。
-- =====================================================================

create table if not exists public.gw_companies (
  id          uuid primary key default gen_random_uuid(),
  group_id    uuid not null references public.gw_groups (id) on delete cascade,
  name        text not null check (char_length(btrim(name)) between 1 and 100),
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  unique (group_id, name),
  unique (id, group_id)
);
create index if not exists gw_companies_group_idx on public.gw_companies (group_id);

-- 成员所属的 Company（可空 = 还没分到 Company）；Company 必须属于同一个 Business
alter table public.gw_group_members add column if not exists company_id uuid;
alter table public.gw_group_members
  add constraint gw_group_members_company_fk
  foreign key (company_id, group_id) references public.gw_companies (id, group_id)
  on delete set null (company_id);
create index if not exists gw_group_members_company_idx on public.gw_group_members (company_id);

alter table public.gw_companies enable row level security;
revoke all on public.gw_companies from anon;

-- 看得到 Business 就看得到它底下的 Company；只有 super_admin 能新增、改名、删除
create policy gw_companies_select on public.gw_companies
  for select to authenticated
  using (exists (select 1 from public.gw_groups g where g.id = group_id));
create policy gw_companies_write on public.gw_companies
  for all to authenticated
  using ((select public.gw_is_super_admin()))
  with check ((select public.gw_is_super_admin()));

-- 在同一个 Business 里换 Company（拖拉）：和新增 / 移除成员同样的权限
create policy gw_group_members_update on public.gw_group_members
  for update to authenticated
  using ((select public.gw_can_manage_group_member(group_id, user_id)))
  with check ((select public.gw_can_manage_group_member(group_id, user_id)));

create trigger gw_audit after insert or update or delete on public.gw_companies
  for each row execute function public.gw_audit_row();
