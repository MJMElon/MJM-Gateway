-- =====================================================================
-- Gateway（gw_）基础表结构
-- 只新增 gw_* 对象，不触碰现有 workrecords_* / machinery_* 表。
-- 不在 auth.users 上建立触发器：gw_profiles 只由 Gateway 后台建立。
-- =====================================================================

-- 部门
create table public.gw_departments (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique check (code ~ '^[A-Z0-9_-]{1,32}$'),
  name        text not null,
  created_at  timestamptz not null default now()
);

-- 用户资料（连 auth.users）
create table public.gw_profiles (
  id                    uuid primary key references auth.users (id) on delete cascade,
  email                 text not null,
  full_name             text not null,
  department_id         uuid references public.gw_departments (id) on delete set null,
  role                  text not null default 'user' check (role in ('super_admin', 'admin', 'user')),
  status                text not null default 'active' check (status in ('active', 'disabled')),
  must_change_password  boolean not null default true,
  locale                text not null default 'zh-CN' check (locale in ('zh-CN', 'en', 'ms')),
  theme                 text not null default 'system' check (theme in ('light', 'dark', 'system')),
  layout_initialized    boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index gw_profiles_department_idx on public.gw_profiles (department_id);
create unique index gw_profiles_email_idx on public.gw_profiles (lower(email));

-- 群组（department_id 为空 = 全公司群组，只有 super_admin 能管理）
create table public.gw_groups (
  id             uuid primary key default gen_random_uuid(),
  name           text not null unique,
  description    text,
  department_id  uuid references public.gw_departments (id) on delete set null,
  sort_order     integer not null default 0,
  created_at     timestamptz not null default now()
);

create table public.gw_group_members (
  group_id    uuid not null references public.gw_groups (id) on delete cascade,
  user_id     uuid not null references public.gw_profiles (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index gw_group_members_user_idx on public.gw_group_members (user_id);

-- 模块
-- access_level: 1=外部链接 / 2=Token 跳转 / 3=SSO
-- department_id: 所属部门；部门 admin 只能管理本部门模块的权限；为空 = 只有 super_admin 能授权
create table public.gw_modules (
  id             uuid primary key default gen_random_uuid(),
  code           text not null unique check (code ~ '^[A-Z0-9_-]{2,40}$'),
  name           text not null,
  icon           text not null default 'app-window',
  url            text not null,
  description    text,
  category       text,
  access_level   smallint not null default 1 check (access_level in (1, 2, 3)),
  is_active      boolean not null default true,
  open_mode      text not null default 'new_tab' check (open_mode in ('new_tab', 'same_tab')),
  department_id  uuid references public.gw_departments (id) on delete set null,
  sort_order     integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table public.gw_group_modules (
  group_id    uuid not null references public.gw_groups (id) on delete cascade,
  module_id   uuid not null references public.gw_modules (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (group_id, module_id)
);
create index gw_group_modules_module_idx on public.gw_group_modules (module_id);

-- 个人例外：allow = 个人允许，deny = 个人禁止（禁止优先）
create table public.gw_user_module_overrides (
  user_id     uuid not null references public.gw_profiles (id) on delete cascade,
  module_id   uuid not null references public.gw_modules (id) on delete cascade,
  effect      text not null check (effect in ('allow', 'deny')),
  created_at  timestamptz not null default now(),
  primary key (user_id, module_id)
);
create index gw_overrides_module_idx on public.gw_user_module_overrides (module_id);

-- ---------------------------------------------------------------------
-- 版面（与权限分开存）：权限关掉时版面记录保留，开回来位置还在
-- ---------------------------------------------------------------------
create table public.gw_user_folders (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.gw_profiles (id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 40),
  color       text not null default 'slate',
  sort_order  integer not null default 0,
  collapsed   boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (id, user_id)
);
create index gw_user_folders_user_idx on public.gw_user_folders (user_id);

create table public.gw_user_layout (
  user_id     uuid not null references public.gw_profiles (id) on delete cascade,
  module_id   uuid not null references public.gw_modules (id) on delete cascade,
  folder_id   uuid,
  sort_order  integer not null default 0,
  card_size   text not null default 'large' check (card_size in ('large', 'small', 'list')),
  updated_at  timestamptz not null default now(),
  primary key (user_id, module_id),
  -- 文件夹必须属于同一用户；删除文件夹时只把 folder_id 设为空（回到未分类）
  foreign key (folder_id, user_id) references public.gw_user_folders (id, user_id)
    on delete set null (folder_id)
);

-- 最近打开
create table public.gw_module_opens (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.gw_profiles (id) on delete cascade,
  module_id  uuid not null references public.gw_modules (id) on delete cascade,
  opened_at  timestamptz not null default now()
);
create index gw_module_opens_user_idx on public.gw_module_opens (user_id, opened_at desc);

-- 已看过的模块（用于模块库「NEW」标记）
create table public.gw_user_module_seen (
  user_id    uuid not null references public.gw_profiles (id) on delete cascade,
  module_id  uuid not null references public.gw_modules (id) on delete cascade,
  seen_at    timestamptz not null default now(),
  primary key (user_id, module_id)
);

-- 公告条（department_id 为空 = 全公司）
create table public.gw_announcements (
  id             uuid primary key default gen_random_uuid(),
  message        text not null check (char_length(message) between 1 and 500),
  level          text not null default 'info' check (level in ('info', 'warning')),
  department_id  uuid references public.gw_departments (id) on delete cascade,
  is_active      boolean not null default true,
  starts_at      timestamptz not null default now(),
  ends_at        timestamptz,
  created_by     uuid references public.gw_profiles (id) on delete set null,
  created_at     timestamptz not null default now()
);

-- 登录失败记录（只有服务端 service_role 能读写）
create table public.gw_login_attempts (
  email         text primary key,
  failed_count  integer not null default 0,
  locked_until  timestamptz,
  updated_at    timestamptz not null default now()
);

-- 目标系统调用「查询权限」接口用的 API Key（只存 hash，只有 service_role 能读写）
create table public.gw_module_api_keys (
  module_id   uuid primary key references public.gw_modules (id) on delete cascade,
  key_hash    text not null,
  key_prefix  text not null,
  created_at  timestamptz not null default now()
);

-- 操作记录（不能修改、不能删除，见 gw_audit migration）
create table public.gw_audit_logs (
  id             bigint generated always as identity primary key,
  created_at     timestamptz not null default now(),
  actor_id       uuid,
  actor_email    text,
  department_id  uuid,
  action         text not null,
  target_type    text not null,
  target_id      text,
  target_label   text,
  before_data    jsonb,
  after_data     jsonb
);
create index gw_audit_logs_created_idx on public.gw_audit_logs (created_at desc);
create index gw_audit_logs_actor_idx on public.gw_audit_logs (actor_id);
create index gw_audit_logs_dept_idx on public.gw_audit_logs (department_id);

-- updated_at
create function public.gw_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger gw_profiles_touch before update on public.gw_profiles
  for each row execute function public.gw_touch_updated_at();
create trigger gw_modules_touch before update on public.gw_modules
  for each row execute function public.gw_touch_updated_at();
create trigger gw_user_layout_touch before update on public.gw_user_layout
  for each row execute function public.gw_touch_updated_at();
