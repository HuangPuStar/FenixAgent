# 用户与权限

> 涉及文件：`src/plugins/auth.ts`、`src/auth/`、`src/plugins/require-team-scope.ts`、`src/repositories/resource-permission.ts`、`src/routes/web/*.ts`、`src/db/schema.ts`

## 这个模块干什么

RCS 的权限系统回答两个问题：
1. **你是谁？** ——认证（Authentication）
2. **你能看什么、能改什么？** ——授权（Authorization）

## 一句话总结

RCS 已经实现**多租户组织隔离**模型：better-auth organization 插件提供组织管理，所有业务资源同时按 `organizationId` + `userId` 进行双重隔离。`resource_permission` 表支持组织间资源分享（目前仅 `read` 操作）。用户角色分为 `owner` / `admin` / `member` 三级。

---

## 用户模型

用户由 better-auth 管理，存在 `user` 表中：

| 字段 | 说明 |
|------|------|
| `id` | better-auth 生成的用户 ID（text） |
| `name` | 用户名 |
| `email` | 邮箱（唯一） |
| `emailVerified` | 是否验证过邮箱 |
| `image` | 头像 URL |

用户通过 `/api/auth/sign-up/email`（注册）和 `/api/auth/sign-in/email`（登录）创建和获取 session。密码存储在 `account` 表中（better-auth 管理）。

### 个人组织自动创建

用户注册时，`better-auth.ts` 的 `databaseHooks.user.create.after` 钩子自动执行：
1. 创建以用户名命名的 `organization` 记录（slug: `personal-{userId前8位}`）
2. 在 `member` 表中插入该用户为 `owner` 角色

此后用户可以创建额外组织、邀请其他用户加入。

---

## 组织模型（better-auth organization 插件）

RCS 通过 better-auth 的 `organization` 插件实现了完整的多租户组织管理。

### 组织表

**`organization`**（`schema.ts:82-89`）：

| 字段 | 说明 |
|------|------|
| `id` | 组织 ID（text） |
| `name` | 组织名称 |
| `slug` | URL 友好的唯一标识 |
| `logo` | 品牌 Logo URL |
| `metadata` | 扩展元数据（JSONB） |

**`member`**（`schema.ts:91-107`）：成员关联表，含 `organizationId`、`userId`、`role`。`(organizationId, userId)` 有唯一索引。

**`invitation`**（`schema.ts:109-131`）：邀请管理，含 `email`、`role`、`status`、`expiresAt`。

### 角色

| 角色 | 说明 |
|------|------|
| `owner` | 组织所有者，可管理组织设置、删除组织 |
| `admin` | 管理员，可邀请/移除成员、管理资源 |
| `member` | 普通成员，可访问组织内已授权的资源 |

每个用户在不同组织中可以有不同角色。

### 活跃组织选择

`AuthContext` 在认证时构建，活跃组织从以下来源解析（优先级递减）：
1. `x-active-org-id` HTTP header
2. `activeOrganizationId` query parameter
3. `active_org_id` cookie

若未指定，回退到用户的第一个组织。结果缓存 60 秒（`org-context.ts`）。

---

## 认证（Authentication）

### 四种认证方式

| 方式 | macro 名 | 用在哪 | 凭证 |
|------|----------|--------|------|
| Cookie Session | `sessionAuth` | `/web/*` 路由（前端） | better-auth session cookie |
| API Key | `apiKeyAuth` | `/acp/*`、`/v1/*` 路由（acp-link、CLI） | `Bearer rcs_xxx` 或 `?token=rcs_xxx` |
| UUID | `uuidAuth` | 会话分享历史查询 | `?uuid=xxx` |
| JWT | `sessionIngressAuth` | `/v2/session_ingress` | Worker JWT token |

绝大多数控制面板 API 用 `sessionAuth`，Agent 侧通信用 `apiKeyAuth`。

### apiKeyAuth 的两级优先链

`tryApiKeyAuth()` 在 `plugins/auth.ts:82-143` 实现：

```
请求到达，提取 token
       │
       ▼
  ① environment.secret 匹配？
     从 environment 表查 secret 字段
     命中 → 用该环境的 userId 作为当前用户
     同时从 environment.organizationId 获取组织上下文
     角色：org 环境为 member，个人环境为 owner
       │ 未命中
       ▼
  ② better-auth API Key 验证？
     auth.api.verifyApiKey({ body: { key: token } })
     命中 → 用 key 的 referenceId 作为当前用户
     从 apikey.metadata 恢复 organizationId + role
     通过 isUserMemberOfOrganization() 二次校验成员关系
       │ 未命中
       ▼
     返回 401
```

**注意**：不再存在 legacy `RCS_API_KEYS` 环境变量的第三级回退。

### sessionAuth 的双通道降级

`authenticateRequest()` 在 `plugins/auth.ts:149-192` 实现：

1. 先尝试 session cookie 认证（`auth.api.getSession`）
2. cookie 失效时自动降级到 `tryApiKeyAuth()`
3. cookie 路径额外通过 `loadOrgContext()` 构建完整的 `AuthContext`

---

## 授权（Authorization）

### 当前模型：组织 + 用户双重隔离

RCS 当前的授权是基于**组织所有权 + 用户所有权**的双重隔离：

- 每个资源都属于一个**组织**（`organizationId` 字段）和一个**用户**（`userId` 字段）
- 用户只能访问自己组织内的资源
- 组织内用户可以通过 `resource_permission` 表获得跨用户资源的访问权限

实现模式：

```
1. 从 store.authContext 获取当前用户和组织（authGuardPlugin 已完成认证）
2. 查询时 WHERE organization_id = authContext.organizationId AND user_id = currentUser.id
3. 修改/删除时先查资源，检查 organizationId 和 userId
4. 不匹配则返回 404（注意：不是 403，避免泄露资源是否存在的信息）
```

### `requireOrgScope` 组织屏障

`src/plugins/require-team-scope.ts` 提供了统一的组织级权限校验函数：

```typescript
const denied = requireOrgScope(store.authContext, resourceOrgId);
if (denied) return denied;
```

用于在路由 handler 中快速断言"当前用户能否访问指定组织的资源"。校验 `authContext.organizationId === resourceOrgId`，不符合返回 403。

### 各资源的隔离实现

#### 环境（Environment）

- **字段**：`organizationId` + `userId`（`schema.ts:233,230`）
- **列表**：按 `organizationId` 过滤
- **详情/修改/删除**：检查 `env.organizationId !== authContext.organizationId` → 404
- **创建**：自动绑定 `organizationId = authContext.organizationId`、`userId = user.id`
- **secret 只返回给所有者**：`GET /environments/:id` 返回 secret，列表不返回

#### 会话（Session）

- **隔离**：检查 `session.userId && session.userId !== user.id` → 403
- **历史**：支持两种访问方式——sessionAuth（cookie）或 uuidAuth（`?uuid=` 参数，用于分享场景）

#### 实例（Instance）

- **列表**：`listInstances(user.id)` —— 按创建者过滤
- **spawn**：`spawnInstanceFromEnvironment(user.id, envId)` —— 内部检查环境所有权
- **stop**：`stopInstance(id, user.id)` —— 内部比较 `inst.userId !== userId` → "Not your instance"

#### 配置（Config）

7 个配置模块全部以 `organizationId` + `userId` 为双参数隔离：

- **Provider**：`organizationId` + `userId`（`schema.ts:463,460`）
- **Model**：`organizationId`（`schema.ts:486`），通过 `providerId` 间接关联到组织
- **Agent Config**：`organizationId` + `userId`（`schema.ts:510,507`）
- **Skill**：`organizationId` + `userId`（`schema.ts:559,556`），唯一约束 `(organizationId, name)`
- **MCP Server**：`organizationId` + `userId`（`schema.ts:538,535`），唯一约束 `(organizationId, name)`
- **MCP Tool 缓存**：`organizationId`（`schema.ts:171`），按 `(organizationId, serverName)` 索引
- **Model**：`organizationId` + `userId`（间接）

Service 层每个查询都带 `WHERE organization_id = ?` 和 `WHERE user_id = ?`。

#### 知识库（Knowledge Base）

- **字段**：`organizationId` + `userId`（`schema.ts:271,268`）
- **所有操作**都以 `userId` 为首参数，Service 层内部检查所有权

#### API Key

- **字段**：`referenceId`（即 `userId`，`schema.ts:141`），`metadata` 中存储 `organizationId` 和 `role`
- **列表**：`listApiKeysByUser(user.id)` —— 只返回当前用户的 key
- **创建/删除/重命名**：匹配 `referenceId` + key 的 `organizationId`

#### 定时任务（Task）

- **字段**：`organizationId` + `userId`（`schema.ts:347,344`）
- **所有操作**通过 `getTask(userId, taskId)` 确保所有权检查

### `resource_permission` 表：组织间资源分享

`resource_permission`（`schema.ts:584-617`）支持将组织内的配置资源授权给其他组织或公开所有：

| 字段 | 说明 |
|------|------|
| `organizationId` | 资源所属组织 |
| `resourceType` | 资源类型：`provider` / `skill` / `mcp_server` / `agent_config` |
| `resourceId` | 资源 ID |
| `principalType` | 授权对象类型：`all`（所有人）或 `organization`（指定组织） |
| `principalId` | 当 `principalType = organization` 时，指定目标组织 ID |
| `action` | 当前仅支持 `read` |
| `createdBy` | 授权创建者 |

唯一约束：`(organizationId, resourceType, resourceId, principalType, principalId, action)`（允许 NULL）。

Repository 层（`src/repositories/resource-permission.ts`）提供方法：
- `listByResource()`：列出某资源的所有权限授予
- `listAccessibleForPrincipal()`：查询某组织可访问的外部资源
- `canReadExternalResource()`：快速判断某组织是否有某资源的 read 权限
- `createGrant()` / `deleteGrant()`：管理授权

这允许组织 A 把某个 Provider 或 Skill 分享给组织 B 使用，无需手动复制配置。

### 例外：WebSocket 路由

WebSocket 路由（`/acp/ws`、`/acp/relay/:agentId`）的认证在 upgrade 阶段完成（`routes/acp/index.ts`），不走 Elysia 的 macro 机制。认证成功后 userId 和 authContext 传递给 transport 层，后续消息处理不再重复校验权限。

---

## 当前没有的功能

以下是当前代码中**不存在**的权限能力：

| 能力 | 现状 |
|------|------|
| 跨用户资源访问（同组织内） | 通过 `resource_permission` 表支持（仅 `read`），但未全面应用到所有资源类型 |
| 资源分享（只读/可写） | `share_link` / `shareEventSnapshot` 表已有会话快照分享，功能开发中 |
| 资源级权限（谁能访问这个 Agent） | `resource_permission` 已支持四种配置资源，Agent 运行实例级别暂未支持 |
| API Key 的作用域限制 | 没有。一个 key 可以访问该用户的所有资源 |
| Workspace 路径隔离 | 只做了黑名单（不能访问 /etc、/usr 等系统目录），没有用户间的目录隔离 |
| 操作审计日志 | 没有。没有记录谁在什么时候做了什么 |

---

## 资源可见性总表

| 资源 | 组织隔离 | 用户隔离 | 隔离方式 | 列表查询 |
|------|----------|----------|----------|----------|
| 环境 | ✅ | ✅ | `organizationId` + `userId` | 按 org 过滤 |
| 会话 | ✅ | ✅ | `session.userId`（通过环境间接关联 org） | `WHERE user_id = ?` |
| 实例 | ✅ | ✅ | `instance.userId`（内存 Map） | 内存过滤 `i.userId === userId` |
| Provider | ✅ | ✅ | `organizationId` + `user_id` | `WHERE org_id = ? AND user_id = ?` |
| Model | ✅ | -（关联 Provider） | `organizationId` | `WHERE organization_id = ?` |
| Agent Config | ✅ | ✅ | `organizationId` + `user_id` | `WHERE org_id = ? AND user_id = ?` |
| Skill | ✅ | ✅ | `organizationId` + `user_id`，唯一约束 | `WHERE org_id = ? AND user_id = ?` |
| MCP Server | ✅ | ✅ | `organizationId` + `user_id`，唯一约束 | `WHERE org_id = ? AND user_id = ?` |
| MCP Tool | ✅ | ❌ | `organizationId` | `WHERE organization_id = ?` |
| 知识库 | ✅ | ✅ | `organizationId` + `user_id` | `WHERE org_id = ? AND user_id = ?` |
| API Key | ✅ (metadata) | ✅ (referenceId) | `reference_id` + `metadata.organizationId` | `WHERE reference_id = ?` |
| 定时任务 | ✅ | ✅ | `organizationId` + `user_id` | `WHERE org_id = ? AND user_id = ?` |
| 执行日志 | ✅ | ✅ | 通过任务间接隔离 | 先验任务所有权 |
| Channel 绑定 | ❌ | ❌ | 无 org/user 字段 | 全量查询 |

> **注意**：`channel_binding` 是唯一既无 `organizationId` 也无 `userId` 的业务表，属于全局共享。`mcp_tool` 缓存表已从全局共享升级为按组织隔离。

---

## 和其他模块的关系

- `plugins/auth.ts` → 所有路由（通过 macro 注入认证逻辑和 `AuthContext`）
- `auth/better-auth.ts` → `db/schema.ts`（user/session/account/organization/member/invitation/apikey 表）
- `services/org-context.ts` → `plugins/auth.ts`（`loadOrgContext` 构建 AuthContext）
- `plugins/require-team-scope.ts` → 各路由 handler（`requireOrgScope` 校验组织权限）
- `repositories/resource-permission.ts` → 配置路由（组织间资源分享的读写）
- 每个路由的 handler → `store.authContext.organizationId` + `store.user.id`（双重隔离）
- 每个路由的 handler → `error(404, ...)` 或 `error(403, ...)`（权限拒绝时返回）
