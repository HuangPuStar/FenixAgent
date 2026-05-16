# 认证系统

> 对应文件：`src/auth/`、`src/plugins/auth.ts`

## 这个模块干什么

认证系统负责回答一个问题："这个请求是谁发的？"

RCS 有三种客户端，每种用不同的认证方式：

| 客户端 | 认证方式 | 凭证形态 |
|--------|----------|----------|
| 前端 React 应用 | better-auth session | 浏览器 Cookie |
| acp-link (Agent) | API Key | HTTP Header `Bearer rcs_xxx` 或 `?token=rcs_xxx` |
| v2 Worker | JWT | HTTP Header `Bearer <jwt>` |

## 三个认证组件

### 1. better-auth（`auth/better-auth.ts`）

标准的用户名密码认证。better-auth 是一个第三方库，RCS 使用它的 email/password 模式。

- 用户通过 `/api/auth/*` 注册和登录
- 登录后浏览器获得一个 session cookie
- 后续请求自动携带 cookie，服务端通过 `auth.api.getSession()` 校验
- Session 有效期 7 天，每天自动续期

### 2. API Key Service（`auth/api-key-service.ts`）

per-user 的 API Key，格式为 `rcs_` + 48 位 hex。每个用户可以创建多个 API Key，用于非浏览器的场景（acp-link 连接、API 调用）。

关键操作：
- **createApiKey**：生成 `rcs_xxx` 格式的 key，存入 `api_key` 表
- **validateApiKeyAndGetUser**：通过 key 查用户，命中后异步更新 `lastUsedAt`
- **listApiKeysByUser**：返回脱敏列表（只显示前 8 位 + 后 4 位）
- **deleteApiKey**：删除指定 key
- **validateLegacyApiKey**：校验 `RCS_API_KEYS` 环境变量中的全局 key（遗留）

### 3. JWT（`auth/jwt.ts`）

遗留代码，仅用于 v2 Worker 协议的 token 生成和验证。使用 HS256 算法，密钥从 `RCS_JWT_SECRET` 环境变量读取。

## authGuardPlugin（`plugins/auth.ts`）

这是认证的核心调度器。它通过 Elysia 的 **macro** 机制，让路由声明式地选择认证方式。

路由写法：

```typescript
app.post("/web/sessions", handler, { sessionAuth: true })   // cookie 认证
app.post("/acp/ws", handler, { apiKeyAuth: true })           // API Key 认证
```

### apiKeyAuth 的认证优先级

当路由使用 `apiKeyAuth` 时，按以下顺序尝试：

```text
① environment secret 匹配
   ↓ 不匹配
② per-user API Key（api_key 表）
   ↓ 不匹配
③ legacy 全局 API Key（RCS_API_KEYS 环境变量）
   ↓ 不匹配
   返回 401
```

environment secret 优先级最高，这样 spawned instance 的 relay 连接可以直接用环境的 secret 完成认证，同时自动绑定到对应的环境记录。

## 和其他模块的关系

- `better-auth.ts` → `db/`（存储用户和 session 到 PostgreSQL）
- `api-key-service.ts` → `db/schema.ts`（`api_key` 表）
- `plugins/auth.ts` → `auth/better-auth.ts`、`auth/api-key-service.ts`、`auth/jwt.ts`
- `plugins/auth.ts` → `repositories/environment.ts`（environment secret 匹配）
- 所有使用认证的路由 → `plugins/auth.ts` 的 macro
