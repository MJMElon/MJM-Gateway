# 目标系统接入 Gateway

## 接入级别

| 级别 | 说明 | 目标系统要做什么 |
| --- | --- | --- |
| 1 外部链接 | Gateway 只是打开网址 | 不用改，目标系统照常自己登录 |
| 2 Token 跳转 | Gateway 带 60 秒 Token 跳转，免登录进入 | 验证 Token，见下文 |
| 3 SSO | 目标系统直接用同一个 Supabase Auth | 目前和第 1 级相同，直接打开网址 |

## 第 2 级：Token 跳转

1. 超级管理员在「权限后台 → 模块」把模块设成「2 · Token 跳转」，并按「产生 API Key」。Key 只显示一次。
2. 用户在 Gateway 点模块后，Gateway 调用 `gw-issue-token`，浏览器被导向：

   ```
   https://目标系统网址?gw_token=<JWT>
   ```

3. 目标系统**在服务端**用 API Key 兑换 Token：

   ```http
   POST https://briqzyxfxsvulyizzbiu.supabase.co/functions/v1/gw-check-access
   x-gw-api-key: gwk_...
   Content-Type: application/json

   { "token": "<gw_token>" }
   ```

   回应：

   ```json
   { "allowed": true, "module_code": "DIESEL-HQ",
     "user": { "id": "…", "email": "…", "full_name": "…", "gw_departments": { "code": "HQ", "name": "总部" } } }
   ```

   - 每个 Token 只能兑换一次（第二次回 `409 token_already_used`）
   - Token 60 秒后过期；签名不对、模块不符都回 `invalid_token`
   - 兑换时会再检查一次目前权限（帐号停用、模块下架、个人禁止都会回 `allowed: false`）

4. 兑换成功后，目标系统建立自己的 session，并把网址上的 `gw_token` 去掉。

### Token 内容（ES256 JWT）

| 栏位 | 内容 |
| --- | --- |
| `iss` | `mjm-gateway` |
| `aud` / `mod` | 模块代码，例如 `DIESEL-HQ` |
| `sub` | Gateway 用户 id |
| `email` | 用户 email |
| `jti` | Token 唯一编号 |
| `exp` | 签发后 60 秒 |

如果只想自行验证签名（不经过兑换接口），公钥在 `GET /functions/v1/gw-jwks`。但这样无法保证 Token 只用一次，建议用兑换接口。

## 查询权限

目标系统随时可以确认某人现在还能不能用这个模块（例如每次 session 续期时）：

```http
POST /functions/v1/gw-check-access
x-gw-api-key: gwk_...

{ "user_id": "…" }      或      { "email": "someone@example.com" }
```

API Key 绑定单一模块：一个系统的 Key 不能查询其他模块的权限。
