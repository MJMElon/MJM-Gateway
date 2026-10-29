-- =====================================================================
-- 第 2 级接入：Token 一次性使用记录
-- 目标系统通过 gw-check-access 兑换 Token 时写入；同一个 Token 不能用第二次
-- 只有 service_role（Edge Function）能读写
-- =====================================================================
create table public.gw_token_redemptions (
  jti          uuid primary key,
  user_id      uuid not null references public.gw_profiles (id) on delete cascade,
  module_id    uuid not null references public.gw_modules (id) on delete cascade,
  redeemed_at  timestamptz not null default now()
);
create index gw_token_redemptions_time_idx on public.gw_token_redemptions (redeemed_at);

alter table public.gw_token_redemptions enable row level security;
revoke all on public.gw_token_redemptions from anon, authenticated;
