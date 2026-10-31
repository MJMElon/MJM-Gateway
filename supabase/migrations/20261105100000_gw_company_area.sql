-- =====================================================================
-- Company 说明、每个 Business 底下的面积（area）
--  - gw_companies.description
--  - gw_business_companies.area / area_unit：同一个 Company 在不同 Business 可以有不同面积
-- 只新增栏位，不删任何东西。
-- =====================================================================
alter table public.gw_companies
  add column description text check (char_length(description) <= 300);

alter table public.gw_business_companies
  add column area numeric(12, 2) check (area >= 0),
  add column area_unit text not null default 'ha' check (char_length(area_unit) between 1 and 10);
