-- =====================================================================
-- 每个用户一个固定代码（U0001、U0002 …），之后对应现有系统的人员时用。
--  - 现有用户按建立时间补上代码
--  - 新用户自动取下一个号码
-- 只动 gw_profiles（新增一栏）。
-- =====================================================================

alter table public.gw_profiles add column user_code text unique check (user_code ~ '^U[0-9]{4,}$');

create sequence public.gw_user_code_seq;

with ordered as (
  select id, row_number() over (order by created_at, id) as rn from public.gw_profiles
)
update public.gw_profiles p
set user_code = 'U' || lpad(o.rn::text, 4, '0')
from ordered o
where o.id = p.id;

select setval('public.gw_user_code_seq', greatest(1, (select count(*) from public.gw_profiles)), (select count(*) > 0 from public.gw_profiles));

create function public.gw_set_user_code()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.user_code is null then
    new.user_code := 'U' || lpad(nextval('public.gw_user_code_seq')::text, 4, '0');
  end if;
  return new;
end;
$$;

create trigger gw_set_user_code before insert on public.gw_profiles
  for each row execute function public.gw_set_user_code();

alter table public.gw_profiles alter column user_code set not null;

revoke execute on function public.gw_set_user_code() from public, anon, authenticated;
