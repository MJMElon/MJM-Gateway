-- Gateway 权限测试（本地执行：npx supabase test db）
begin;
create extension if not exists pgtap with schema extensions;
select plan(41);

-- ---------------------------------------------------------------------
-- 测试资料
-- ---------------------------------------------------------------------
insert into auth.users (id, email, instance_id, aud, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'super@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a2', 'admin.hq@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a3', 'user.hq@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a4', 'user.ops@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a5', 'nogw@test.local', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');

insert into public.gw_departments (id, code, name) values
  ('00000000-0000-0000-0000-0000000000d1', 'HQ', '总部'),
  ('00000000-0000-0000-0000-0000000000d2', 'OPS', '营运部');

insert into public.gw_profiles (id, email, full_name, department_id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'super@test.local', '超级管理员', null, 'super_admin'),
  ('00000000-0000-0000-0000-0000000000a2', 'admin.hq@test.local', '总部管理员', '00000000-0000-0000-0000-0000000000d1', 'admin'),
  ('00000000-0000-0000-0000-0000000000a3', 'user.hq@test.local', '总部员工', '00000000-0000-0000-0000-0000000000d1', 'user'),
  ('00000000-0000-0000-0000-0000000000a4', 'user.ops@test.local', '营运员工', '00000000-0000-0000-0000-0000000000d2', 'user');

insert into public.gw_modules (id, code, name, url, department_id) values
  ('00000000-0000-0000-0000-0000000000b1', 'DIESEL-HQ', 'HQ 车辆 Diesel', 'https://diesel.example.com', '00000000-0000-0000-0000-0000000000d1'),
  ('00000000-0000-0000-0000-0000000000b2', 'HR', '人事系统', 'https://hr.example.com', null),
  ('00000000-0000-0000-0000-0000000000b3', 'WIKI', '公司知识库', 'https://wiki.example.com', null),
  ('00000000-0000-0000-0000-0000000000b4', 'OLD', '旧系统', 'https://old.example.com', null);
update public.gw_modules set is_active = false where code = 'OLD';

insert into public.gw_groups (id, name, department_id) values
  ('00000000-0000-0000-0000-0000000000c1', '全体员工', null),
  ('00000000-0000-0000-0000-0000000000c2', '总部车队', '00000000-0000-0000-0000-0000000000d1');

insert into public.gw_group_members (group_id, user_id) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a3'),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a3'),
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a4'),
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a2');

insert into public.gw_group_modules (group_id, module_id) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b3'),
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b4'),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000b1');

-- 模拟登录身份
create function pg_temp.login(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  set local role authenticated;
$$;
create function pg_temp.logout() returns void language sql as $$
  reset role;
  select set_config('request.jwt.claims', null, true);
$$;

-- ---------------------------------------------------------------------
-- 1. 权限计算
-- ---------------------------------------------------------------------
select set_eq(
  $$ select code from public.gw_modules where id in (select public.gw__effective_module_ids('00000000-0000-0000-0000-0000000000a3')) $$,
  array['DIESEL-HQ', 'WIKI'],
  '总部员工：群组模块（下架的 OLD 不算）'
);

insert into public.gw_user_module_overrides values
  ('00000000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-0000000000b2', 'allow'),
  ('00000000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-0000000000b3', 'deny');
select set_eq(
  $$ select code from public.gw_modules where id in (select public.gw__effective_module_ids('00000000-0000-0000-0000-0000000000a4')) $$,
  array['HR'],
  '营运员工：群组 + 个人允许 − 个人禁止（禁止优先）'
);

-- ---------------------------------------------------------------------
-- 2. 一般用户只能看到有权限的模块
-- ---------------------------------------------------------------------
select pg_temp.login('00000000-0000-0000-0000-0000000000a3');
select set_eq($$ select code from public.gw_modules $$, array['DIESEL-HQ', 'WIKI'], '用户只看到自己有权限的模块（连名字都看不到其他的）');
select is((select count(*) from public.gw_profiles)::int, 1, '用户只看到自己的资料');
select is((select count(*) from public.gw_user_module_overrides)::int, 0, '用户看不到别人的例外设定');
select is((select count(*) from public.gw_audit_logs)::int, 0, '一般用户看不到操作记录');
select throws_ok(
  $$ update public.gw_profiles set role = 'super_admin' where id = '00000000-0000-0000-0000-0000000000a3' $$,
  '42501', null, '用户不能改自己的角色'
);
select lives_ok(
  $$ update public.gw_profiles set theme = 'dark', locale = 'en' where id = '00000000-0000-0000-0000-0000000000a3' $$,
  '用户可以改自己的语言和主题'
);
select throws_ok(
  $$ insert into public.gw_user_module_overrides values ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000b2', 'allow') $$,
  '42501', null, '用户不能给自己加个人允许'
);
select throws_ok(
  $$ insert into public.gw_group_members values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a3') $$,
  '42501', null, '用户不能把自己加进群组'
);
select throws_ok($$ select * from public.gw_login_attempts $$, '42501', null, '客户端不能读登录记录表');

-- 第一次登录：按群组自动排版（两个群组 → 两个文件夹）
select lives_ok($$ select public.gw_init_layout() $$, '初始化首页');
select is((select count(*) from public.gw_user_folders)::int, 2, '按群组建立 2 个文件夹');
select is((select count(*) from public.gw_user_layout where folder_id is not null)::int, 2, '模块已放进群组文件夹');
select is(jsonb_array_length(public.gw_get_home() -> 'modules'), 2, 'gw_get_home 回传 2 个模块');
select throws_ok(
  $$ select public.gw_get_home('00000000-0000-0000-0000-0000000000a4') $$,
  '42501', null, '用户不能预览别人的首页'
);
select throws_ok(
  $$ select public.gw_save_layout('[{"module_id":"00000000-0000-0000-0000-0000000000b2","sort_order":1}]') $$,
  '42501', null, '不能把没权限的模块加进版面'
);

-- 删除文件夹 → 模块回到未分类
delete from public.gw_user_folders where name = '总部车队';
select is(
  (select folder_id from public.gw_user_layout where module_id = '00000000-0000-0000-0000-0000000000b1'),
  null, '删除文件夹后模块回到未分类'
);
select is((select count(*) from public.gw_user_layout)::int, 2, '删除文件夹不会删掉版面记录');
select pg_temp.logout();

-- ---------------------------------------------------------------------
-- 3. 权限关掉 → 不显示但版面保留；开回来位置还在
-- ---------------------------------------------------------------------
update public.gw_user_layout set sort_order = 42 where module_id = '00000000-0000-0000-0000-0000000000b1';
insert into public.gw_user_module_overrides values
  ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000b1', 'deny');
select pg_temp.login('00000000-0000-0000-0000-0000000000a3');
select is(jsonb_array_length(public.gw_get_home() -> 'layout'), 1, '被禁止的模块不出现在首页');
select pg_temp.logout();
select is((select count(*) from public.gw_user_layout where user_id = '00000000-0000-0000-0000-0000000000a3')::int, 2, '版面记录仍保留');
delete from public.gw_user_module_overrides where user_id = '00000000-0000-0000-0000-0000000000a3';
select pg_temp.login('00000000-0000-0000-0000-0000000000a3');
select ok(
  (public.gw_get_home() -> 'layout') @> '[{"module_id":"00000000-0000-0000-0000-0000000000b1","sort_order":42}]',
  '权限开回来，原位置还在'
);
select pg_temp.logout();

-- 帐号停用 → 全部看不到
update public.gw_profiles set status = 'disabled' where id = '00000000-0000-0000-0000-0000000000a3';
select pg_temp.login('00000000-0000-0000-0000-0000000000a3');
select is((select count(*) from public.gw_modules)::int, 0, '停用帐号看不到任何模块');
select pg_temp.logout();
update public.gw_profiles set status = 'active' where id = '00000000-0000-0000-0000-0000000000a3';

-- ---------------------------------------------------------------------
-- 4. 部门 admin
-- ---------------------------------------------------------------------
select pg_temp.login('00000000-0000-0000-0000-0000000000a2');
select set_eq($$ select email from public.gw_profiles $$, array['admin.hq@test.local', 'user.hq@test.local'], 'admin 只看到本部门用户');
select lives_ok(
  $$ insert into public.gw_user_module_overrides values ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000b1', 'deny') $$,
  'admin 可以设定本部门用户对本部门模块的例外'
);
select throws_ok(
  $$ insert into public.gw_user_module_overrides values ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000b1', 'allow') $$,
  '42501', null, 'admin 不能给自己加权限'
);
select throws_ok(
  $$ insert into public.gw_user_module_overrides values ('00000000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-0000000000b1', 'allow') $$,
  '42501', null, 'admin 不能管其他部门的用户'
);
select throws_ok(
  $$ insert into public.gw_user_module_overrides values ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000b2', 'allow') $$,
  '42501', null, 'admin 不能授权不属于本部门的模块'
);
select throws_ok(
  $$ insert into public.gw_group_members values ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a2') $$,
  '42501', null, 'admin 不能把自己加进群组'
);
select throws_ok(
  $$ update public.gw_profiles set role = 'admin' where id = '00000000-0000-0000-0000-0000000000a3' $$,
  '42501', null, 'admin 不能改角色'
);
select throws_ok(
  $$ insert into public.gw_modules (code, name, url) values ('NEWMOD', '新模块', 'https://x') $$,
  '42501', null, 'admin 不能管理模块'
);
select pg_temp.logout();

-- ---------------------------------------------------------------------
-- 5. 操作记录、匿名、登录锁定
-- ---------------------------------------------------------------------
select ok((select count(*) from public.gw_audit_logs) > 0, '权限改动自动写入操作记录');
select is(
  (select target_label from public.gw_audit_logs where target_type = 'user_module_overrides' order by id desc limit 1),
  'user.hq@test.local → DIESEL-HQ (deny)', '个人例外的操作记录有可读的对象说明'
);
select pg_temp.login('00000000-0000-0000-0000-0000000000a2');
select ok(
  (select count(*) from public.gw_group_modules where group_id = '00000000-0000-0000-0000-0000000000c1') > 0,
  'admin 看得到自己所属的全公司群组的授权（权限矩阵显示正确）'
);
select pg_temp.logout();
select throws_ok($$ delete from public.gw_audit_logs $$, '42501', null, '操作记录不能删除（连数据库管理员也不行）');

set local role anon;
select throws_ok($$ select * from public.gw_modules $$, '42501', null, '未登录不能读取模块');
reset role;

select public.gw_login_failed('Lock@Test.local') from generate_series(1, 5);
select ok(public.gw_login_locked_until('lock@test.local') > now() + interval '14 minutes', '连续输错 5 次锁 15 分钟');

-- ---------------------------------------------------------------------
-- 6. 首页小工具：只能动自己的；重设首页会清掉
-- ---------------------------------------------------------------------
select pg_temp.login('00000000-0000-0000-0000-0000000000a3');
select lives_ok(
  $$ insert into public.gw_user_widgets (user_id, widget_type, size) values ('00000000-0000-0000-0000-0000000000a3', 'clock', 'small') $$,
  '用户可以加自己的小工具'
);
select throws_ok(
  $$ insert into public.gw_user_widgets (user_id, widget_type) values ('00000000-0000-0000-0000-0000000000a4', 'clock') $$,
  '42501', null, '不能替别人加小工具'
);
select pg_temp.logout();
insert into public.gw_user_widgets (user_id, widget_type) values ('00000000-0000-0000-0000-0000000000a4', 'notes');
select pg_temp.login('00000000-0000-0000-0000-0000000000a3');
select is((select count(*) from public.gw_user_widgets)::int, 1, '看不到别人的小工具');
select public.gw_reset_layout();
select is((select count(*) from public.gw_user_widgets)::int, 0, '重设首页会清掉自己的小工具');
select pg_temp.logout();

select * from finish();
rollback;
