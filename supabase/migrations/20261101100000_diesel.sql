-- =====================================================================
-- Diesel 模块：车辆、加油报销（claim）、收据照片
--
-- 权限分两层：
--  1. Gateway（入口）：DIESEL 模块的 Access = 可以进入；Admin = 这个模块的最高管理者
--     （角色负责 DIESEL、super_admin 也一样）
--  2. 模块里面的 User Access（diesel_user_access，只有模块管理者能设定，
--     只列出在 Gateway 有 DIESEL Access 的人）：
--       Cash Claim = 可以报销自己用现金加的油
--       Report     = 可以看报表（全部车辆、全部记录）
--  Fleet Card（油卡清单、充值、每次刷卡加油记录）由模块管理者记录；
--  油卡加油和现金报销一起算进每台车的用油。
--  审核人不能审核自己的 claim（super_admin 除外）
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

-- 模块里的 User Access（每个人在 Diesel 模块里可以用哪些页面）
create table public.diesel_user_access (
  user_id     uuid primary key references public.gw_profiles (id) on delete cascade,
  can_claim   boolean not null default false,
  can_report  boolean not null default false,
  updated_by  uuid references public.gw_profiles (id) on delete set null,
  updated_at  timestamptz not null default now()
);

-- 油卡（Fleet Card）
create table public.diesel_cards (
  id             uuid primary key default gen_random_uuid(),
  card_no        text not null unique check (char_length(btrim(card_no)) between 1 and 40),
  provider       text check (char_length(provider) <= 40),
  vehicle_id     uuid references public.diesel_vehicles (id) on delete set null,
  monthly_limit  numeric(10, 2) check (monthly_limit >= 0),
  status         text not null default 'active' check (status in ('active', 'blocked', 'cancelled')),
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- 油卡充值
create table public.diesel_card_reloads (
  id           uuid primary key default gen_random_uuid(),
  card_id      uuid not null references public.diesel_cards (id) on delete restrict,
  reload_date  date not null default current_date,
  amount       numeric(10, 2) not null check (amount > 0),
  reference    text check (char_length(reference) <= 80),
  notes        text check (char_length(notes) <= 500),
  created_by   uuid default auth.uid() references public.gw_profiles (id) on delete set null,
  created_at   timestamptz not null default now()
);
create index diesel_card_reloads_card_idx on public.diesel_card_reloads (card_id, reload_date);

-- 油卡加油记录（谁、哪台车、加多少）
create table public.diesel_card_usage (
  id           uuid primary key default gen_random_uuid(),
  card_id      uuid not null references public.diesel_cards (id) on delete restrict,
  vehicle_id   uuid not null references public.diesel_vehicles (id) on delete restrict,
  driver_id    uuid references public.gw_profiles (id) on delete set null,
  fill_date    date not null default current_date,
  odometer_km  integer check (odometer_km >= 0),
  litres       numeric(8, 2) not null check (litres > 0 and litres < 2000),
  amount       numeric(10, 2) not null check (amount >= 0),
  station      text check (char_length(station) <= 120),
  notes        text check (char_length(notes) <= 500),
  created_by   uuid default auth.uid() references public.gw_profiles (id) on delete set null,
  created_at   timestamptz not null default now()
);
create index diesel_card_usage_card_idx on public.diesel_card_usage (card_id, fill_date);
create index diesel_card_usage_vehicle_idx on public.diesel_card_usage (vehicle_id, fill_date);
create index diesel_card_usage_driver_idx on public.diesel_card_usage (driver_id, fill_date);

create trigger diesel_cards_touch before update on public.diesel_cards
  for each row execute function public.gw_touch_updated_at();
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

-- 某人在 Gateway 有没有 DIESEL 的 Access（模块 User Access 只能设定这些人）
create function public.diesel_user_has_access(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.gw_modules m
    where m.code = 'DIESEL' and m.id in (select public.gw__effective_module_ids(p_user))
  )
$$;

-- 模块里的页面权限（管理者全部都有）
create function public.diesel_can_claim()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.diesel_can_use() and (
    public.diesel_is_admin()
    or exists (select 1 from public.diesel_user_access a where a.user_id = auth.uid() and a.can_claim)
  )
$$;

create function public.diesel_can_report()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.diesel_can_use() and (
    public.diesel_is_admin()
    or exists (select 1 from public.diesel_user_access a where a.user_id = auth.uid() and a.can_report)
  )
$$;

-- 报表与下拉选单用的人员名单：在 Gateway 有 DIESEL Access 的人（只给 Report / 管理者）
create function public.diesel_people()
returns table (id uuid, full_name text, email text, is_admin boolean, can_claim boolean, can_report boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.full_name, p.email, coalesce(mm.is_admin, false), coalesce(a.can_claim, false), coalesce(a.can_report, false)
  from public.gw_profiles p
  join public.gw_module_members mm on mm.user_id = p.id
  join public.gw_modules m on m.id = mm.module_id and m.code = 'DIESEL'
  left join public.diesel_user_access a on a.user_id = p.id
  where public.diesel_can_report() and public.diesel_user_has_access(p.id)
  order by p.full_name
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

revoke execute on function
  public.diesel_can_use(), public.diesel_is_admin(), public.diesel_user_has_access(uuid),
  public.diesel_can_claim(), public.diesel_can_report(), public.diesel_people(), public.diesel_claims_guard()
from public, anon;
grant execute on function
  public.diesel_can_use(), public.diesel_is_admin(), public.diesel_user_has_access(uuid),
  public.diesel_can_claim(), public.diesel_can_report(), public.diesel_people()
to authenticated;
revoke execute on function public.diesel_claims_guard() from authenticated;

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------
alter table public.diesel_vehicles enable row level security;
alter table public.diesel_claims enable row level security;
alter table public.diesel_user_access enable row level security;
alter table public.diesel_cards enable row level security;
alter table public.diesel_card_reloads enable row level security;
alter table public.diesel_card_usage enable row level security;
revoke all on public.diesel_vehicles, public.diesel_claims, public.diesel_user_access,
  public.diesel_cards, public.diesel_card_reloads, public.diesel_card_usage from anon;

-- 模块 User Access：自己看得到自己的；管理者设定（对象一定要在 Gateway 有 DIESEL Access）
create policy diesel_user_access_select on public.diesel_user_access
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.diesel_is_admin()));
create policy diesel_user_access_write on public.diesel_user_access
  for all to authenticated
  using ((select public.diesel_is_admin()))
  with check ((select public.diesel_is_admin()) and (select public.diesel_user_has_access(user_id)));

-- 油卡、充值、刷卡记录：管理者记录；有 Report 的人看得到
create policy diesel_cards_select on public.diesel_cards
  for select to authenticated using ((select public.diesel_can_report()));
create policy diesel_cards_write on public.diesel_cards
  for all to authenticated
  using ((select public.diesel_is_admin())) with check ((select public.diesel_is_admin()));
create policy diesel_card_reloads_select on public.diesel_card_reloads
  for select to authenticated using ((select public.diesel_can_report()));
create policy diesel_card_reloads_write on public.diesel_card_reloads
  for all to authenticated
  using ((select public.diesel_is_admin())) with check ((select public.diesel_is_admin()));
create policy diesel_card_usage_select on public.diesel_card_usage
  for select to authenticated using ((select public.diesel_can_report()));
create policy diesel_card_usage_write on public.diesel_card_usage
  for all to authenticated
  using ((select public.diesel_is_admin())) with check ((select public.diesel_is_admin()));

-- 车辆：有 Access 的人看得到；管理者新增、修改、删除
create policy diesel_vehicles_select on public.diesel_vehicles
  for select to authenticated
  using ((select public.diesel_can_use()));
create policy diesel_vehicles_write on public.diesel_vehicles
  for all to authenticated
  using ((select public.diesel_is_admin()))
  with check ((select public.diesel_is_admin()));

-- 现金报销：自己的；管理者、有 Report 的人看全部
create policy diesel_claims_select on public.diesel_claims
  for select to authenticated
  using (claimant_id = (select auth.uid()) or (select public.diesel_can_report()));
-- 新增：要有 Cash Claim 权限，只能替自己报销，状态一定是 pending，车辆要启用中
create policy diesel_claims_insert on public.diesel_claims
  for insert to authenticated
  with check (
    (select public.diesel_can_claim())
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
    and (select public.diesel_can_claim())
  );
create policy "diesel receipts read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'diesel-receipts'
    and ((storage.foldername(name))[1] = (select auth.uid())::text or (select public.diesel_can_report()))
  );
create policy "diesel receipts delete own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'diesel-receipts' and (storage.foldername(name))[1] = (select auth.uid())::text);
