# 认证系统

> 对应文件：`src/auth/`、`src/plugins/auth.ts`、`src/services/org-context.ts`

## 这个模块干什么

认证系统负责回答一个问题："这个请求是谁发的？"

RCS 有三种客户端，每种用不同的认证方式：

| 客户端 | 认证方式 | 凭证形态 |
|--------|----------|----------|
| 前端 React 应用 | better-auth session | 浏览器 Cookie |
| acp-link (Agent) / API 调用 | API Key / Environment Secret | HTTP Header `Bearer rcs_xxx` 或 `?token=rcs_xxx` |
| v2 Worker | JWT | HTTP Header `Bearer <jwt>` |
| 分享链接访问 | UUID | `?uuid=xxx` query param |

## 认证组件

### 1. better-auth（`auth/better-auth.ts`）

标准的用户名密码认证。better-auth 是一个第三方库，RCS 使用它的 email/password 模式，并启用以下插件：

- **organization 插件**：多租户组织支持，用户注册后自动创建个人组织（`databaseHooks.user.create.after`），新用户以 `owner` 角色加入
- **apiKey 插件**：per-user 的 API Key，前缀 `rcs_`，支持 metadata（用于存储 `organizationId` 和 `role` 等组织上下文）

关键配置：
- Session 有效期 7 天，每天自动续期
- 密码传输加密：`authPlugin` 在 `/api/auth/*` 路由上对 `sign-in/email`、`sign-up/email`、`change-password` 等接口的请求体中的 `AESGCM:` 前缀密码做透明解密（参见 `encryption.ts`）
- `trustedOrigins` 由 `trusted-origins.ts` 动态构建，支持 `RCS_TRUSTED_ORIGINS`、`BETTER_AUTH_URL`、`RCS_BASE_URL` 三个环境变量组合

### 2. API Key 认证

API Key 功能由 better-auth 内置 `apiKey` 插件直接处理，**不再有**独立的 `api-key-service.ts`。

**创建**：better-auth apiKey 插件在 `better-auth.ts:36-44` 配置，前缀 `rcs_`：
```typescript
apiKey({
  defaultPrefix: "rcs_",
  enableMetadata: true,
  rateLimit: { enabled: false },
})
```

**存储**：API Key 的元数据存在 `apikey` 表（`schema.ts:134-164`），由 better-auth 管理。Key 本体 SHA-256 哈希存储，创建时返回明文（仅一次）。

**认证**：`tryApiKeyAuth()` 在 `plugins/auth.ts:82-143`，按两级优先级尝试：

```text
① environment secret 匹配
   ↓ 不匹配
② better-auth API Key 验证（auth.api.verifyApiKey）
   ↓ 不匹配
   返回 401
```

environment secret 优先级最高，这样 spawn instance 的 relay 连接可以直接用环境的 secret 完成认证，同时自动绑定到对应的环境记录和所属组织。

**重要**：`tryApiKeyAuth()` 中**没有** legacy `RCS_API_KEYS` 环境变量的 fallback。legacy 全局 API Key 的支持已移除。

### 3. JWT（`auth/jwt.ts`）

轻量 JWT 实现，使用 HS256（HMAC-SHA256）算法。仅用于 v2 Worker 协议的 token 生成和验证。

- **签名密钥**：从 `RCS_API_KEYS` 环境变量的第一个元素读取（`jwt.ts:31-34` 的 `getSigningKey()`），**不是** `RCS_JWT_SECRET`
- **用途**：Worker 发起 session ingress / SSE / CCR 连接时使用 JWT 认证
- **Payload**：`{ session_id, role: "worker", iat, exp }`
- **验证**：`verifyWorkerJwt()` 使用 timing-safe comparison 防止时序攻击

### 4. 辅助模块

| 文件 | 作用 |
|------|------|
| `auth/encryption.ts` | AES-256-GCM 密码加密。前端通过 `GET /api/auth/encryption-key` 获取公钥（启动时随机生成的 32 字节密钥），登录/注册时将密码用 `AESGCM:iv.data` 格式加密传输。`decryptPassword()` 在 `authPlugin` 中透明解密 |
| `auth/token.ts` | 遗留 token 系统。生成 `rct_` 前缀的 session token（16 字节随机 hex），通过 `tokenRepo` 持久化。用于旧的会话认证方式，新代码已不再使用 |
| `auth/trusted-origins.ts` | 动态构建 better-auth 的 `trustedOrigins` 列表。从 `localhost:5173`、`BETTER_AUTH_URL`、`RCS_BASE_URL`、`RCS_TRUSTED_ORIGINS`（逗号分隔）聚合，自动提取 origin 并去重 |

## authGuardPlugin（`plugins/auth.ts`）

这是认证的核心调度器。它通过 Elysia 的 **macro** 机制，让路由声明式地选择认证方式。

### 四种认证 macro

路由写法：

```typescript
app.post("/web/sessions", handler, { sessionAuth: true })            // cookie 认证
app.post("/acp/ws", handler, { apiKeyAuth: true })                   // API Key / Environment Secret 认证
app.get("/web/sessions/:id/history", handler, { uuidAuth: true })    // UUID query param 认证
app.post("/v2/session_ingress", handler, { sessionIngressAuth: true }) // Worker JWT 认证
```

| macro | 凭证 | 验证逻辑 | 适用场景 |
|-------|------|----------|----------|
| `sessionAuth` | session cookie | `authenticateRequest()` → cookie → tryApiKeyAuth fallback | `/web/*` 控制面板 API |
| `apiKeyAuth` | `Bearer <token>` 或 `?token=` | `tryApiKeyAuth()` → environment secret → API Key | `/acp/*`、`/v1/*` |
| `uuidAuth` | `?uuid=` query param | 提取 UUID 存入 `store.uuid`，不做身份校验 | 会话分享链接历史查询 |
| `sessionIngressAuth` | `Bearer <jwt>` | `verifyWorkerJwt()` 验证 Worker JWT | `/v2/session_ingress` |

### `authenticateRequest` 双通道逻辑

`authenticateRequest()`（`plugins/auth.ts:149-192`）是 session 认证的统一入口，采用**双通道降级**策略：

```text
请求到达
  │
  ▼
session cookie 有效？
  │ 是 → 构建 AuthContext（user + organizationId + role）→ 返回认证结果
  │ 否
  ▼
tryApiKeyAuth() 降级尝试
  │ 成功 → 返回认证结果（authSession 为 null）
  │ 失败
  ▼
返回 null（未认证）
```

这意味着 `sessionAuth` macro 的路由不仅支持 cookie，在 cookie 失效时还会自动降级尝试 API Key / Environment Secret 认证。`apiKeyAuth` 则仅尝试 API Key / Environment Secret，不检查 cookie。

### `AuthContext` 多租户认证上下文

认证完成后，`AuthContext` 被注入到 store：

```typescript
export interface AuthContext {
  organizationId: string;       // 当前活跃的组织 ID
  organizationName?: string;    // 组织名称（用于日志/显示）
  userId: string;               // 当前用户 ID
  role: "owner" | "admin" | "member";  // 用户在组织中的角色
}
```

**组织上下文解析**（`services/org-context.ts`）：
1. 从请求中提取 `activeOrganizationId`（优先级：`x-active-org-id` header > `?activeOrganizationId` query > `active_org_id` cookie）
2. 通过 better-auth organization API 查询用户在该组织中的成员信息和角色
3. 若未指定 active org，回退到用户的第一个组织
4. 结果缓存 60 秒

在 `tryApiKeyAuth()` 中：
- **environment secret 路径**：从 `environment.organizationId` 获取组织（若未配置则 fallback 到 `environment.userId`），角色为 `owner`（个人环境）或 `member`（组织环境）
- **API Key 路径**：从 `apikey.metadata` 中恢复 `organizationId` 和 `role`，并通过 `isUserMemberOfOrganization()` 二次校验成员关系

### 测试注入

`setTestAuth()` 和 `setTestOrgContext()` 允许测试绕过认证：
- `_testAuth` 注入完整的认证结果（user + session + authContext）
- `_testOrgContext` 注入组织上下文缓存，跳过 DB 查询

## 和其他模块的关系

- `auth/better-auth.ts` → `db/schema.ts`（user、session、account、organization、member、invitation、apikey 表）
- `auth/encryption.ts` → `plugins/auth.ts`（`/api/auth/encryption-key` 路由、密码解密中间件）
- `auth/jwt.ts` → `plugins/auth.ts`（`sessionIngressAuth` macro）
- `auth/trusted-origins.ts` → `auth/better-auth.ts`（构建 trustedOrigins）
- `auth/token.ts` → `repositories/`（`tokenRepo`，遗留）
- `plugins/auth.ts` → `services/org-context.ts`（`loadOrgContext` 构建 AuthContext）
- `plugins/auth.ts` → `repositories/environment.ts`（environment secret 匹配）
- `plugins/require-team-scope.ts` → `plugins/auth.ts`（`requireOrgScope` 函数，校验组织级资源权限）
- 所有使用认证的路由 → `plugins/auth.ts` 的 macro
