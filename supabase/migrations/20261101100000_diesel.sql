-- =====================================================================
-- Diesel 模块：车辆、加油报销（claim）、收据照片
--
-- 权限跟着 Gateway 的 DIESEL 模块走：
--  - 有 DIESEL 的 Access：看得到车辆，可以替车辆报销加油（只看得到自己的 claim）
--  - DIESEL 的 Admin（或角色负责 DIESEL、或 super_admin）：管理车辆、看全部 claim、审核
--    审核人不能审核自己的 claim（super_admin 除外）
-- 收据照片放在私有 bucket「diesel-receipts」，路径 = 上传者 id / 档名
-- 只新增 diesel_* 对象、DIESEL 模块资料和一个 storage bucket。
-- =====================================================================

-- Gateway 上的模块入口（同一个网站里的页面，同一个分页打开）
insert into public.gw_modules (code, name, icon, url, description, category, access_level, open_mode, sort_order)
values ('DIESEL', 'Diesel Claims', 'fuel', 'diesel/index.html', 'Vehicles, fuel use and diesel receipt claims', 'Fleet', 1, 'same_tab', 10)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------
-- 资料表
-- ---------------------------------------------------------------------
create table public.diesel_vehicles (
  id               uuid primary key default gen_random_uuid(),
  plate_no         text not null unique check (char_length(btrim(plate_no)) between 1 and 20),
  name             text check (char_length(name) <= 80),
  vehicle_type     text not null default 'car' check (vehicle_type in ('car', 'pickup', 'van', 'lorry', 'motorcycle', 'machinery', 'other')),
  fuel_type        text not null default 'diesel' check (fuel_type in ('diesel', 'petrol')),
  tank_capacity_l  numeric(6, 1) check (tank_capacity_l > 0),
  group_id         uuid references public.gw_groups (id) on delete set null,
  company_id       uuid references public.gw_companies (id) on delete set null,
  driver_id        uuid references public.gw_profiles (id) on delete set null,
  status           text not null default 'active' check (status in ('active', 'inactive')),
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table public.diesel_claims (
  id           uuid primary key default gen_random_uuid(),
  vehicle_id   uuid not null references public.diesel_vehicles (id) on delete restrict,
  claimant_id  uuid not null default auth.uid() references public.gw_profiles (id) on delete restrict,
  fill_date    date not null default current_date,
  odometer_km  integer check (odometer_km >= 0),
  litres       numeric(8, 2) not null check (litres > 0 and litres < 2000),
  amount       numeric(10, 2) not null check (amount >= 0),
  station      text check (char_length(station) <= 120),
  receipt_path text,
  notes        text check (char_length(notes) <= 500),
  status       text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'paid')),
  reviewed_by  uuid references public.gw_profiles (id) on delete set null,
  reviewed_at  timestamptz,
  review_note  text check (char_length(review_note) <= 500),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index diesel_claims_vehicle_idx on public.diesel_claims (vehicle_id, fill_date);
create index diesel_claims_claimant_idx on public.diesel_claims (claimant_id, created_at desc);
create index diesel_claims_status_idx on public.diesel_claims (status);

create trigger diesel_vehicles_touch before update on public.diesel_vehicles
  for each row execute function public.gw_touch_updated_at();
create trigger diesel_claims_touch before update on public.diesel_claims
  for each row execute function public.gw_touch_updated_at();

-- ---------------------------------------------------------------------
-- 权限函数
-- ---------------------------------------------------------------------
-- 能不能用 Diesel 模块（有 Access）
create function public.diesel_can_use()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.gw_is_super_admin()
    or exists (
      select 1 from public.gw_modules m
      where m.code = 'DIESEL' and m.id in (select public.gw_my_module_ids())
    )
$$;

-- 是不是 Diesel 的管理者（模块 Admin、负责 DIESEL 的角色、super_admin）
create function public.diesel_is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.gw_is_super_admin()
    or exists (
      select 1 from public.gw_modules m
      where m.code = 'DIESEL' and m.is_active and m.id in (select public.gw_my_managed_module_ids())
    )
$$;

-- claim 栏位保护：
--  - 一般用户（自己的 claim）只能在 pending 时修改内容，不能改状态、审核栏位、报销人
--  - 管理者改状态时自动记录审核人与时间；不能审核自己的 claim（super_admin 除外）
create function public.diesel_claims_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or auth.role() = 'service_role' then
    return new;
  end if;

  if new.claimant_id <> old.claimant_id then
    raise exception 'diesel: claimant cannot be changed' using errcode = '42501';
  end if;

  if new.status is distinct from old.status then
    if not public.diesel_is_admin() then
      raise exception 'diesel: only a Diesel admin can review claims' using errcode = '42501';
    end if;
    if old.claimant_id = auth.uid() and not public.gw_is_super_admin() then
      raise exception 'diesel: you cannot review your own claim' using errcode = '42501';
    end if;
    new.reviewed_by := auth.uid();
    new.reviewed_at := now();
    return new;
  end if;

  if not public.diesel_is_admin()
     and (new.reviewed_by is distinct from old.reviewed_by
          or new.reviewed_at is distinct from old.reviewed_at
          or new.review_note is distinct from old.review_note) then
    raise exception 'diesel: only a Diesel admin can review claims' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger diesel_claims_guard before update on public.diesel_claims
  for each row execute function public.diesel_claims_guard();

revoke execute on function public.diesel_can_use(), public.diesel_is_admin(), public.diesel_claims_guard() from public, anon;
grant execute on function public.diesel_can_use(), public.diesel_is_admin() to authenticated;
revoke execute on function public.diesel_claims_guard() from authenticated;

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------
alter table public.diesel_vehicles enable row level security;
alter table public.diesel_claims enable row level security;
revoke all on public.diesel_vehicles, public.diesel_claims from anon;

-- 车辆：有 Access 的人看得到；管理者新增、修改、删除
create policy diesel_vehicles_select on public.diesel_vehicles
  for select to authenticated
  using ((select public.diesel_can_use()));
create policy diesel_vehicles_write on public.diesel_vehicles
  for all to authenticated
  using ((select public.diesel_is_admin()))
  with check ((select public.diesel_is_admin()));

-- claim：自己的 + 管理者看全部
create policy diesel_claims_select on public.diesel_claims
  for select to authenticated
  using (claimant_id = (select auth.uid()) or (select public.diesel_is_admin()));
-- 新增：只能替自己报销，状态一定是 pending，车辆要启用中
create policy diesel_claims_insert on public.diesel_claims
  for insert to authenticated
  with check (
    (select public.diesel_can_use())
    and claimant_id = (select auth.uid())
    and status = 'pending'
    and reviewed_by is null
    and exists (select 1 from public.diesel_vehicles v where v.id = vehicle_id and v.status = 'active')
  );
-- 修改：自己的 pending claim，或管理者（审核）；细节由 diesel_claims_guard 检查
create policy diesel_claims_update on public.diesel_claims
  for update to authenticated
  using ((claimant_id = (select auth.uid()) and status = 'pending') or (select public.diesel_is_admin()))
  with check ((claimant_id = (select auth.uid()) and status = 'pending') or (select public.diesel_is_admin()));
-- 删除：自己还在 pending 的 claim；super_admin 可以删任何 claim
create policy diesel_claims_delete on public.diesel_claims
  for delete to authenticated
  using ((claimant_id = (select auth.uid()) and status = 'pending') or (select public.gw_is_super_admin()));

-- ---------------------------------------------------------------------
-- 收据照片：私有 bucket，档案放在「上传者 id/」底下
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('diesel-receipts', 'diesel-receipts', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do nothing;

create policy "diesel receipts upload" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'diesel-receipts'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (select public.diesel_can_use())
  );
create policy "diesel receipts read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'diesel-receipts'
    and ((storage.foldername(name))[1] = (select auth.uid())::text or (select public.diesel_is_admin()))
  );
create policy "diesel receipts delete own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'diesel-receipts' and (storage.foldername(name))[1] = (select auth.uid())::text);
