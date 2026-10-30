-- Diesel 模块权限测试（本地执行：npx supabase test db）
begin;
create extension if not exists pgtap with schema extensions;
select plan(24);

-- a1 super_admin；a2 DIESEL Admin；a3、a5 有 DIESEL Access；a4 没有
insert into auth.users (id, email, instance_id, aud, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'super@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a2', 'fleet.admin@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a3', 'driver@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a4', 'office@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a5', 'driver2@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');
insert into public.gw_profiles (id, email, full_name, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'super@test.local', 'Super', 'super_admin'),
  ('00000000-0000-0000-0000-0000000000a2', 'fleet.admin@test.local', 'Fleet Admin', 'user'),
  ('00000000-0000-0000-0000-0000000000a3', 'driver@test.local', 'Driver', 'user'),
  ('00000000-0000-0000-0000-0000000000a4', 'office@test.local', 'Office', 'user'),
  ('00000000-0000-0000-0000-0000000000a5', 'driver2@test.local', 'Driver Two', 'user');
insert into public.gw_groups (id, name) values ('00000000-0000-0000-0000-0000000000c1', 'Fleet');
insert into public.gw_group_modules (group_id, module_id) select '00000000-0000-0000-0000-0000000000c1', id from public.gw_modules where code = 'DIESEL';
insert into public.gw_group_members (group_id, user_id) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a2'),
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a3'),
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a4'),
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a5');
insert into public.gw_module_members (user_id, module_id, is_admin)
select u, m.id, u = '00000000-0000-0000-0000-0000000000a2'
from public.gw_modules m,
     unnest(array['00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000a5']::uuid[]) as u
where m.code = 'DIESEL';

insert into public.diesel_vehicles (id, plate_no, name) values
  ('00000000-0000-0000-0000-0000000000d1', 'WXY 1234', 'Hilux'),
  ('00000000-0000-0000-0000-0000000000d2', 'OLD 1', 'Old lorry');
update public.diesel_vehicles set status = 'inactive' where plate_no = 'OLD 1';

create function pg_temp.login(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  set local role authenticated;
$$;
create function pg_temp.logout() returns void language sql as $$
  reset role;
  select set_config('request.jwt.claims', null, true);
$$;

select ok((select count(*) from public.gw_modules where code = 'DIESEL' and url = 'diesel/index.html') = 1, 'Gateway 上有 DIESEL 模块入口');

-- ---------------------------------------------------------------------
-- 司机：有 Access
-- ---------------------------------------------------------------------
select pg_temp.login('00000000-0000-0000-0000-0000000000a3');
select ok(public.diesel_can_use(), '司机可以用 Diesel');
select ok(not public.diesel_is_admin(), '司机不是 Diesel 管理者');
select is((select count(*) from public.diesel_vehicles)::int, 2, '司机看得到车辆清单');
select lives_ok(
  $$ insert into public.diesel_claims (id, vehicle_id, claimant_id, litres, amount, odometer_km)
     values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a3', 50, 107.50, 10000) $$,
  '司机可以报销加油'
);
select throws_ok(
  $$ insert into public.diesel_claims (vehicle_id, claimant_id, litres, amount) values ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a3', 10, 20) $$,
  '42501', null, '停用的车辆不能报销'
);
select throws_ok(
  $$ insert into public.diesel_claims (vehicle_id, claimant_id, litres, amount) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a5', 10, 20) $$,
  '42501', null, '不能替别人报销'
);
select throws_ok(
  $$ insert into public.diesel_claims (vehicle_id, claimant_id, litres, amount, status) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a3', 10, 20, 'approved') $$,
  '42501', null, '不能直接送出已批准的 claim'
);
select lives_ok(
  $$ update public.diesel_claims set litres = 52 where id = '00000000-0000-0000-0000-0000000000e1' $$,
  'pending 时可以修改自己的 claim'
);
select throws_ok(
  $$ update public.diesel_claims set status = 'approved' where id = '00000000-0000-0000-0000-0000000000e1' $$,
  '42501', null, '司机不能批准自己的 claim'
);
select throws_ok(
  $$ insert into public.diesel_vehicles (plate_no) values ('NEW 1') $$,
  '42501', null, '司机不能新增车辆'
);
select pg_temp.logout();

select pg_temp.login('00000000-0000-0000-0000-0000000000a5');
select is((select count(*) from public.diesel_claims)::int, 0, '司机看不到别人的 claim');
select pg_temp.logout();

-- ---------------------------------------------------------------------
-- 没有 Access 的人
-- ---------------------------------------------------------------------
select pg_temp.login('00000000-0000-0000-0000-0000000000a4');
select is((select count(*) from public.diesel_vehicles)::int, 0, '没有 Access：看不到车辆');
select throws_ok(
  $$ insert into public.diesel_claims (vehicle_id, claimant_id, litres, amount) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a4', 10, 20) $$,
  '42501', null, '没有 Access：不能报销'
);
select pg_temp.logout();

-- ---------------------------------------------------------------------
-- Diesel Admin
-- ---------------------------------------------------------------------
select pg_temp.login('00000000-0000-0000-0000-0000000000a2');
select ok(public.diesel_is_admin(), '模块 Admin 是 Diesel 管理者');
select lives_ok($$ insert into public.diesel_vehicles (plate_no, name) values ('NEW 1', 'Van') $$, '管理者可以新增车辆');
select is((select count(*) from public.diesel_claims)::int, 1, '管理者看得到全部 claim');
select lives_ok(
  $$ update public.diesel_claims set status = 'approved', review_note = 'OK' where id = '00000000-0000-0000-0000-0000000000e1' $$,
  '管理者可以批准'
);
select is((select reviewed_by from public.diesel_claims where id = '00000000-0000-0000-0000-0000000000e1'), '00000000-0000-0000-0000-0000000000a2'::uuid, '自动记录审核人');
insert into public.diesel_claims (id, vehicle_id, claimant_id, litres, amount)
values ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a2', 30, 64.50);
select throws_ok(
  $$ update public.diesel_claims set status = 'approved' where id = '00000000-0000-0000-0000-0000000000e2' $$,
  '42501', null, '管理者不能批准自己的 claim'
);
select pg_temp.logout();

-- 批准后司机不能再改
select pg_temp.login('00000000-0000-0000-0000-0000000000a3');
update public.diesel_claims set litres = 99 where id = '00000000-0000-0000-0000-0000000000e1';
select pg_temp.logout();
select is((select litres from public.diesel_claims where id = '00000000-0000-0000-0000-0000000000e1'), 52.00, '批准后司机不能再修改');

-- 收回 Access 后什么都看不到
delete from public.gw_module_members where user_id = '00000000-0000-0000-0000-0000000000a3';
select pg_temp.login('00000000-0000-0000-0000-0000000000a3');
select is((select count(*) from public.diesel_vehicles)::int, 0, '收回 Access 后看不到车辆');
select pg_temp.logout();

-- 收据：私有 bucket
select ok((select not public from storage.buckets where id = 'diesel-receipts'), '收据 bucket 是私有的');
set local role anon;
select throws_ok($$ select * from public.diesel_claims $$, '42501', null, '未登录不能读取 claim');
reset role;

select * from finish();
rollback;
