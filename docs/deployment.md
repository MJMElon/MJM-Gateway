# 上线步骤

> 线上 Supabase 项目：**MJM Gateway**（原 NASA Dashboard，ref `briqzyxfxsvulyizzbiu`）。
> 项目里另有在用的 `ai_management_*` 表，以及挂在 `auth.users` 上的触发器 `ai_management_on_auth_user_created`（新建登录帐号会自动加进 AI 管理系统的用户表）。
> 本 repo 的 migration **只新增 `gw_*` 对象**，不修改、不删除任何现有表、函数或资料。

## 1. 套用 migration（需先确认 SQL）

依序套用 `supabase/migrations/` 里的 5 个档案：

1. `20261029100000_gw_schema.sql`：建表
2. `20261029100100_gw_security.sql`：权限函数 + RLS
3. `20261029100200_gw_audit.sql`：操作记录
4. `20261029100300_gw_rpc.sql`：首页、版面、登录锁定、后台用函数
5. `20261029100400_gw_token_redemptions.sql`：Token 一次性使用记录

## 2. 指定第一位超级管理员

Gateway 帐号只能由管理员建立，所以第一位 super_admin 要用 SQL 建立（Supabase SQL Editor）。
如果这个 email 在 Supabase Auth 里已经有帐号，直接连结：

```sql
insert into public.gw_profiles (id, email, full_name, role, must_change_password)
select id, email, '你的名字', 'super_admin', false
from auth.users
where email = 'you@example.com';
```

还没有帐号的话，先到 Supabase Dashboard → Authentication → Users → Add user 建立，再执行上面的 SQL。

## 3. Edge Functions

```bash
node scripts/generate-token-key.mjs                    # 产生 ES256 私钥（JWK）
npx supabase secrets set GW_TOKEN_PRIVATE_JWK='<输出>' --project-ref briqzyxfxsvulyizzbiu
npx supabase functions deploy gw-issue-token gw-check-access gw-jwks --project-ref briqzyxfxsvulyizzbiu
```

可选：`GW_ALLOWED_ORIGIN=https://gateway.你的网域` 限制 CORS 来源（默认 `*`）。

## 4. Supabase Auth 设定

- Authentication → URL Configuration
  - Site URL：Gateway 的网址
  - Redirect URLs：加入 `https://<gateway 网址>/auth/callback`
- Authentication → Emails：设定 SMTP（Supabase 内建邮件每小时只能寄很少封，忘记密码功能需要正式 SMTP）

## 5. 部署 Next.js（例如 Vercel）

环境变量：

| 名称 | 说明 |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://briqzyxfxsvulyizzbiu.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | 只在服务端使用（建立用户、重设密码、登录锁定）|
| `NEXT_PUBLIC_SITE_URL` | Gateway 网址（忘记密码邮件的回跳）|
