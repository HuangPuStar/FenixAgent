# 用户与权限

> 涉及文件：`src/plugins/auth.ts`、`src/auth/`、`src/routes/web/*.ts`、`src/db/schema.ts`

## 这个模块干什么

RCS 的权限系统回答两个问题：
1. **你是谁？** ——认证（Authentication）
2. **你能看什么、能改什么？** ——授权（Authorization）

## 一句话总结

RCS 当前是一个**多租户隔离**模型：每个用户只能看到和操作自己的资源，没有角色（admin/user）、没有跨用户共享（分享功能在建）、没有资源级别的细粒度权限。

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

当前**没有角色字段**，所有用户权限相同，都是平等的"租户"。

---

## 认证（Authentication）

### 四种认证方式

| 方式 | macro 名 | 用在哪 | 凭证 |
|------|----------|--------|------|
| Cookie Session | `sessionAuth` | `/web/*` 路由（前端） | better-auth session cookie |
| API Key | `apiKeyAuth` | `/acp/*`、`/v1/*` 路由（acp-link、CLI） | `Bearer rcs_xxx` 或 `?token=rcs_xxx` |
| UUID | `uuidAuth` | 会话历史查询 | `?uuid=xxx` |
| JWT | `sessionIngressAuth` | `/v1/sessions/:id/ingress` | JWT token |

绝大多数控制面板 API 用 `sessionAuth`，Agent 侧通信用 `apiKeyAuth`。

### apiKeyAuth 的三级优先链

```
请求到达，提取 token
       │
       ▼
  ① environment.secret 匹配？
     从 environment 表查 secret 字段
     命中 → 用该环境的 userId 作为当前用户
     同时记住 authEnvironmentId（后续可识别这是哪个环境的连接）
       │ 未命中
       ▼
  ② per-user API Key 匹配？
     从 api_key 表查 key 字段
     命中 → 用该 key 的 userId 作为当前用户
       │ 未命中
       ▼
  ③ legacy 全局 Key 匹配？
     对比 RCS_API_KEYS 环境变量
     命中 → 用 "system@rcs.local" 用户（自动创建）
       │ 未命中
       ▼
     返回 401
```

environment secret 优先级最高的设计是有意的：spawned instance 的 acp-link 进程需要用环境 secret 认证，同时让服务端知道"这是哪个环境的连接"。

---

## 授权（Authorization）

### 当前模型：用户隔离

RCS 当前的授权是**基于所有权的隔离**——每个资源都属于一个用户（`userId` 字段），用户只能访问自己的资源。

实现方式非常统一，几乎所有 `/web/*` 路由都遵循同一个模式：

```
1. 从 store.user 获取当前用户（authGuardPlugin 已完成认证）
2. 查询时 WHERE user_id = currentUser.id
3. 修改/删除时先查资源，检查 userId === currentUser.id
4. 不匹配则返回 404（注意：不是 403，避免泄露资源是否存在的信息）
```

### 各资源的隔离实现

#### 环境（Environment）

- **列表**：`environmentRepo.listByUserId(user.id)` —— 只返回当前用户的环境
- **详情/修改/删除**：先 `environmentRepo.getById(id)`，再检查 `env.userId !== user.id` → 404
- **创建**：自动绑定 `userId = user.id`
- **secret 只返回给所有者**：`GET /environments/:id` 返回 secret，列表不返回

#### 会话（Session）

- **列表**：`sessionRepo.listByUserId(user.id)` —— 只返回当前用户的会话
- **详情**：检查 `session.userId && session.userId !== user.id` → 403
- **历史**：支持两种访问方式——sessionAuth（cookie）或 uuidAuth（?uuid= 参数，用于分享场景）

#### 实例（Instance）

- **列表**：`listInstances(user.id)` —— 按创建者过滤
- **spawn**：`spawnInstanceFromEnvironment(user.id, envId)` —— 内部检查环境所有权
- **stop**：`stopInstance(id, user.id)` —— 内部比较 `inst.userId !== userId` → "Not your instance"

#### 配置（Config）

6 个配置模块全部以 `userId` 为首参数，Service 层的每个查询都带 `WHERE user_id = ?`：

- `listProviders(userId)` —— 只返回该用户的 Provider
- `upsertProvider(userId, name, data)` —— 按用户隔离
- `getAgentConfig(userId, name)` —— 只返回该用户的 Agent 配置
- ……以此类推

#### 知识库（Knowledge Base）

- **所有操作**都以 `userId` 为首参数，Service 层内部检查所有权
- `getOwnedKnowledgeBaseRow(userId, knowledgeBaseId)` —— 先查记录，再验 userId

#### API Key

- **列表**：`listApiKeysByUser(user.id)` —— 只返回当前用户的 key
- **删除/重命名**：`deleteApiKey(user.id, keyId)` / `updateApiKeyLabel(user.id, keyId, label)` —— 同时匹配 userId 和 keyId

#### 定时任务（Task）

- **所有操作**通过 `getTask(userId, taskId)` 确保所有权检查
- `listTasks(userId)` —— 只返回该用户的任务

### 例外：WebSocket 路由

WebSocket 路由（`/acp/ws`、`/acp/relay/:agentId`）的认证在 upgrade 阶段完成（`routes/acp/index.ts`），不走 Elysia 的 macro 机制。认证成功后 userId 传递给 transport 层，后续消息处理不再重复校验权限。

---

## 当前没有的功能

以下是当前代码中**不存在**的权限能力：

| 能力 | 现状 |
|------|------|
| 角色（admin / user / viewer） | 没有。所有注册用户权限相同 |
| 跨用户资源访问 | 没有。用户 A 看不到用户 B 的任何东西 |
| 资源分享（只读/可写） | 表结构已有（`share_link`、`shareEventSnapshot`），功能开发中 |
| 团队/组织 | 没有。没有 group/team 的概念 |
| 资源级权限（谁能访问这个 Agent） | 没有。所有权是唯一的授权维度 |
| API Key 的作用域限制 | 没有。一个 key 可以访问该用户的所有资源 |
| Workspace 路径隔离 | 只做了黑名单（不能访问 /etc、/usr 等系统目录），没有用户间的目录隔离 |
| 操作审计日志 | 没有。没有记录谁在什么时候做了什么 |

---

## 资源可见性总表

| 资源 | 谁能看到 | 隔离方式 | 列表查询 |
|------|----------|----------|----------|
| 环境 | 创建者 | `environment.userId` | `WHERE user_id = ?` |
| 会话 | 创建者 | `session.userId` | `WHERE user_id = ?` |
| 实例 | 创建者 | `instance.userId`（内存 Map） | 内存过滤 `i.userId === userId` |
| 配置（6 模块） | 创建者 | 各表 `user_id` 字段 | `WHERE user_id = ?` |
| 知识库 | 创建者 | `knowledge_base.user_id` | `WHERE user_id = ?` |
| API Key | 创建者 | `api_key.user_id` | `WHERE user_id = ?` |
| 定时任务 | 创建者 | `scheduled_task.user_id` | `WHERE user_id = ?` |
| 执行日志 | 任务所有者 | 通过任务间接隔离 | 先验任务所有权 |
| Channel 绑定 | 所有人 | 无 userId 字段 | 全量查询 |
| MCP 工具缓存 | 所有人 | 无 userId 字段 | 全量查询 |

> 注意：Channel 绑定和 MCP 工具缓存是全局共享的，不按用户隔离。

---

## 和其他模块的关系

- `plugins/auth.ts` → 所有路由（通过 macro 注入认证逻辑）
- `auth/better-auth.ts` → `db/schema.ts`（user/session/account 表）
- `auth/api-key-service.ts` → `db/schema.ts`（api_key 表）
- 每个路由的 handler → `store.user.id`（获取当前用户 ID，用于数据隔离）
- 每个路由的 handler → `error(404, ...)` 或 `error(403, ...)`（权限拒绝时返回）
