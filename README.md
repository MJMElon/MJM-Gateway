# MJM Gateway

公司系统统一入口：员工登录一次，就能看到并打开自己有权限的所有系统。
Gateway 只管**认证、授权、导航**，不处理业务资料。

- 前端：Next.js 16（App Router）+ TypeScript + Tailwind CSS 4
- 后端：Supabase（项目 `machinery-system`）——Auth、PostgreSQL、RLS、Edge Functions
- 拖拉：dnd-kit（支持手机长按拖拉）
- 界面文字：`messages/zh-CN.json`（以后加 `en.json`、`ms.json`）

## 目录

```
src/app/(auth)/          登录、忘记密码、改密码
src/app/(app)/           首页、模块库、个人设置
src/app/(app)/admin/     权限后台（用户、权限矩阵、群组、模块、部门、公告、操作记录、预览）
src/components/home/     首页拖拉版面
src/i18n/  messages/     多语言
supabase/migrations/     数据库 migration（只新增 gw_* 对象）
supabase/functions/      Edge Functions：gw-issue-token、gw-check-access、gw-jwks
supabase/tests/          RLS 权限测试（pgTAP）
scripts/                 产生签名金钥、本地测试资料
docs/                    目标系统接入说明、上线步骤
```

## 权限模型

- **有效权限** = 所属全部群组的模块 ∪ 个人允许 − 个人禁止（禁止优先）
- 帐号停用或模块下架 → 全部看不到；没有权限的模块连名字都不显示
- 所有检查都在数据库 RLS / 函数里做，前端只负责显示
- **权限和版面分开存**：权限关掉的模块不显示，但 `gw_user_layout` 记录保留；权限开回来，原位置还在
- 角色
  - `super_admin`：管理所有用户、群组、模块、部门；看全部操作记录
  - `admin`：只能管理本部门的一般用户，以及「本部门模块」（`gw_modules.department_id`）的权限；不能给自己加权限（不能改自己所属群组的授权、不能设定自己的例外）
  - `user`：只能看到、打开有权限的模块，自己排首页
- 操作记录 `gw_audit_logs` 由触发器自动写入，不能修改、不能删除（连 service_role 也不行）

## 本地开发

需要 Docker。

```bash
npm install
npx supabase start                      # 启动本地 Supabase，并套用 supabase/migrations
npx supabase test db                    # 执行 RLS 权限测试
node scripts/generate-token-key.mjs     # 产生 Token 签名金钥，存成 supabase/functions/.env：
                                        #   GW_TOKEN_PRIVATE_JWK=<输出>
npx supabase functions serve --env-file supabase/functions/.env
cp .env.example .env.local              # 填入 npx supabase status 显示的本地网址和金钥
node --env-file=.env.local scripts/seed-local.mjs   # 本地测试帐号（密码 Passw0rd123）
npm run dev
```

本地测试帐号：`super@mjm.local`、`admin.hq@mjm.local`、`driver@mjm.local`、`ops@mjm.local`、`new@mjm.local`（会被要求改密码）。

## 已知限制（MVP）

- **登录锁定**（连续输错 5 次锁 15 分钟）在 Gateway 的服务端登录流程里执行。Supabase 的 anon key 是公开的，如果有人绕过 Gateway、直接调用 Supabase Auth API，只会受到 Supabase 本身的频率限制。要完全堵住，需要 Supabase 的 Password Verification Hook（部分付费方案才有）。
- **第一次登录强制改密码**是导航层面的限制（未改密码前所有页面都会被导向改密码页）。
- **第 3 级（SSO）** 目前和第 1 级一样直接打开网址，由目标系统自己做 SSO。
- 模块名称、说明目前只有一种语言（资料库栏位），界面文字已全部走语言文件。

上线步骤见 [docs/deployment.md](docs/deployment.md)，目标系统接入见 [docs/integration.md](docs/integration.md)。
