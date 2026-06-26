# 团队权限设计方案

> 状态：方案设计（未实施）
> 目标：从单用户隔离 → 团队内共享资源 + 管理员全局可见

---

> **2026-06 更新**：本文档中的核心概念已通过 better-auth organization 插件实现，但使用 `organization` 命名而非 `team`。`organization`/`member`/`invitation` 三表、角色（owner/admin/member）、`organizationId` 资源隔离、`AuthContext` 认证上下文均已上线。本文档的详细权限方案（admin 全局视图、跨组资源控制）仍可作为后续增强 roadmap。

---

## 1. 现状

当前权限模型是纯用户隔离：每个资源绑 `userId`，查询 `WHERE user_id = ?`，改删前验 `userId === user.id`。没有角色、没有团队、没有共享。

改动影响面：

| 层 | 涉及文件数 | 改动性质 |
|----|-----------|----------|
| DB Schema | 1 文件（schema.ts） | 新增 3 张表，13 张表加 `team_id` 列 |
| 仓储层 | 5 文件 | 查询条件从 `userId` 改为 `teamId` |
| Service 层 | ~10 文件 | 函数签名加 `teamId`，或抽象权限检查 |
| 路由层 | ~12 文件 | handler 里的所有权检查改为权限检查 |
| 认证层 | 2 文件 | session 里附带团队信息和角色 |

---

## 2. 数据模型

### 2.1 新增三张表

```
team（团队）
├── id              varchar  PK
├── name            varchar  团队名
├── slug            varchar  URL 标识（唯一）
├── createdAt
└── updatedAt

team_member（团队成员）
├── id              uuid     PK
├── teamId          varchar  → team.id
├── userId          varchar  → user.id
├── role            varchar  "owner" | "admin" | "member"
├── joinedAt
└── 唯一约束 (teamId, userId)

team_invite（团队邀请，可选，后续再加）
```

### 2.2 角色定义

| 角色 | 说明 | 能力 |
|------|------|------|
| **owner** | 团队创建者 | 全部 + 删除团队、转让 owner、管理成员 |
| **admin** | 管理员 | 看到团队所有资源 + CRUD 所有资源 + 管理成员 |
| **member** | 普通成员 | 看到团队所有资源 + CRUD 自己创建的资源 |

关键区别：**admin 能改别人创建的资源，member 只能改自己的**。三种角色都能**看到**团队内的所有资源。

### 2.3 现有表变更

给所有需要共享的资源表加 `team_id` 列（nullable，兼容过渡期）：

```text
需要加 team_id 的表（13 张）：
├── environment          环境
├── agent_session        会话
├── api_key              API Key
├── provider             服务商
├── model                模型（通过 provider 间接关联 team）
├── agent_config         Agent 配置
├── mcp_server           MCP 服务器
├── skill                技能
├── user_config          用户偏好
├── knowledge_base       知识库
├── knowledge_resource   知识资源（通过 knowledge_base 间接关联）
├── scheduled_task       定时任务
└── channel_binding      Channel 绑定

不加 team_id 的表：
├── user / session / account / verification  （better-auth 管）
├── task_execution_log    （通过 scheduled_task 间接关联）
├── share_link / share_event_snapshot  （关联 session，后续设计）
└── mcp_tool              （全局缓存）
```

`team_id` 初始为 null，表示"旧数据，属于个人"。新创建的资源自动绑定当前用户的活跃团队。

---

## 3. 权限检查模型

### 3.1 当前模式 vs 目标模式

```
当前：  WHERE user_id = ?                        一个人只看自己的
目标：  WHERE team_id = ?                        团队内所有人看到全部
        + 写操作额外检查 role ≥ 要求             member 只能改自己的，admin 都能改
```

### 3.2 权限检查函数

新增一个权限检查服务，统一处理"能不能对这个资源做这个操作"：

```text
checkPermission(userId, resource, action) → boolean

action = "read" | "create" | "update" | "delete"

逻辑：
  1. 找到 resource 的 teamId
  2. 查 team_member 获取该用户在团队中的 role
  3. 按规则判断：
     - read:  三种角色都能（只要是团队成员）
     - create: 三种角色都能
     - update/delete:
         admin/owner → 允许
         member → resource.userId === userId 才允许
  4. 无 teamId 的旧资源 → 走旧的 userId 匹配逻辑
```

### 3.3 管理员全局可见

admin 和 owner 不仅看到团队资源，还需要一个"跨团队全局视图"的入口。两种实现方式选其一：

**方案 A：全局列表 API（推荐）**

新增 `/web/admin/environments`、`/web/admin/sessions` 等 API，admin 角色可以不带 team_id 过滤，看到所有团队的所有资源。普通 API 不受影响。

**方案 B：在现有列表 API 加 query 参数**

`GET /web/environments?all=true`，admin 角色时忽略 team_id 过滤。

推荐方案 A，因为权限边界更清晰，不会意外泄露到前端。

---

## 4. 改动范围逐层分析

### 4.1 DB Schema（`src/db/schema.ts`）

- 新增 `team`、`team_member` 两张表（team_invite 后续再加）
- 13 张资源表加 `teamId` 列（nullable，`varchar`，references team.id）
- 唯一索引调整：如 `idx_provider_user_name` 改为 `idx_provider_team_name`

### 4.2 认证层（`src/plugins/auth.ts`）

`authGuardPlugin` 的 `sessionAuth` macro 扩展：

```text
当前：认证成功后 store.user = { id, email, name }
目标：认证成功后额外查 team_member 表，附加：
      store.teamId = "当前活跃团队 ID"
      store.teamRole = "owner" | "admin" | "member"

还需要支持"切换团队"：
      POST /web/teams/:id/switch  → 更新 session 中的 activeTeamId
```

### 4.3 仓储层（`src/repositories/`）

查询条件从 `WHERE user_id = ?` 改为 `WHERE team_id = ?`：

- `environmentRepo.listByUserId(userId)` → `listByTeamId(teamId)`
- `sessionRepo.listByUserId(userId)` → `listByTeamId(teamId)`
- 保留 `listByUserId` 用于"我的资源"视图

新增：
- `teamRepo`：团队 CRUD
- `teamMemberRepo`：成员管理、角色查询

### 4.4 Service 层（`src/services/`）

`config-pg.ts` 是最大的改动点（56 处 userId）：

- 每个函数签名从 `(userId, ...)` 改为 `(teamId, userId, role, ...)`
- `WHERE user_id = ?` 改为 `WHERE team_id = ?`
- 写操作（update/delete）加 role 检查：
  - admin/owner → 直接执行
  - member → 额外加 `AND user_id = userId`

`instance.ts`：内存 Map 的 `SpawnedInstance` 加 `teamId` 字段，过滤逻辑改为按 teamId。

### 4.5 路由层（`src/routes/web/`）

handler 的改动模式统一：

```text
当前：
  const user = store.user!;
  const envs = await environmentRepo.listByUserId(user.id);

目标：
  const user = store.user!;
  const teamId = store.teamId!;
  const envs = await environmentRepo.listByTeamId(teamId);
```

所有权检查从 `env.userId !== user.id` 改为调用权限检查服务。

---

## 5. 分阶段实施

不要一次全改。分三阶段走，每阶段可独立上线。

### 阶段 1：团队数据模型 + 基础 CRUD

**目标**：能创建团队、邀请成员、查看团队列表。资源暂时还按 userId 隔离。

改动：
1. 新增 `team`、`team_member` 两张表 + migration
2. 新增 `teamRepo`、`teamMemberRepo`
3. 新增 `services/team.ts`：团队 CRUD + 成员管理
4. 新增 `routes/web/teams.ts`：团队 API
5. `authGuardPlugin` 扩展：session 中存 activeTeamId
6. 前端：团队管理页面

**不改动**：现有资源表的查询逻辑，所有资源继续按 userId 隔离。

### 阶段 2：资源绑定团队 + 共享可见

**目标**：新创建的资源绑定 teamId，团队成员能看到团队内所有资源。

改动：
1. 13 张资源表加 `teamId` 列（migration，nullable）
2. 创建资源时自动填 `teamId = store.teamId`
3. 列表查询改为 `WHERE team_id = ?`（有 teamId 时），回退到 `WHERE user_id = ?`（无 teamId 时）
4. config-pg.ts 56 处改动
5. 仓储层查询方法更新
6. 路由层 handler 更新

**关键兼容**：`teamId` 为 null 的旧数据继续用 userId 隔离，不破坏现有功能。

### 阶段 3：角色权限 + 管理员视图

**目标**：member 只能改自己的，admin/owner 能改所有的。管理员全局视图。

改动：
1. 新增 `services/permission.ts`：统一的权限检查服务
2. 所有写操作路由加上权限检查
3. 新增 `/web/admin/*` 路由：admin 角色看全部资源
4. 前端：管理后台页面

---

## 6. 需要讨论的决策点

在开始实施前，需要确认以下选择：

### 6.1 一个用户可以属于多个团队吗？

建议：**可以**。`team_member` 表天然支持多对多。session 中维护一个 `activeTeamId`，用户可以切换当前团队。

### 6.2 资源创建时绑定哪个团队？

建议：绑定到用户当前的 **activeTeamId**（存在 session 中）。如果用户没有活跃团队（activeTeamId 为 null），资源不绑定团队，走旧的 userId 隔离。

### 6.3 旧的 userId 隔离数据怎么迁移？

建议：**不强制迁移**。加一个后台任务脚本，可以按需把某个用户的所有资源迁移到一个新建的"个人团队"中。但系统始终兼容 `teamId = null` 的数据。

### 6.4 config-pg.ts 的函数签名怎么改？

当前每个函数首参数是 `userId`，改动量 56 处。两个方案：

**方案 A**：签名改为 `(teamId, userId, role, ...)`，所有调用点传新参数
**方案 B**：新增一个 `AuthContext` 对象 `{ teamId, userId, role }`，签名改为 `(ctx: AuthContext, ...)`

建议**方案 B**。一个对象比三个散参数更不容易传错，后续加新字段（比如 `permissions` 数组）也更容易扩展。

### 6.5 model 表怎么关联团队？

`model` 表通过 `providerId` 外键关联 `provider`，`provider` 有 `teamId`。所以 model 不需要直接加 `teamId`——通过 join provider 查。但 config-pg.ts 里的 model 查询需要改为 join provider 的 teamId。

---

## 7. 和其他模块的关系

这个改动影响面最广，几乎涉及所有模块：

- DB Schema → 新增表 + 现有表加列
- 认证层 → session 存团队信息
- 仓储层 → 查询条件更新
- Service 层 → config-pg.ts 56 处、instance.ts、所有 service
- 路由层 → ~12 个文件的 handler
- 前端 → 团队管理 UI + 管理后台 UI

但因为分阶段实施，每个阶段的改动可以独立测试和上线，不会一次性大爆炸。
