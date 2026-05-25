# Team Layer (F001) 执行计划

**目标:** 为 RCS 添加 Team 组织层级，使资源所有权从 `userId` 转移到 `teamId`，支持多人协作和团队切换。

**技术栈:** Elysia + Bun, PostgreSQL + Drizzle ORM, React + Vite + Tailwind v4, better-auth

**设计文档:** `spec/feature_20260517_F001_team-layer/spec-design.md`

## 改动总览

本次改动涉及约 25 个文件，按数据层→服务层→路由层→前端的顺序分层实施。关键决策：AuthContext 用 `{ teamId, userId, role }` 替代散参数 `userId`；teamId 直接 NOT NULL（初级项目，不做旧数据迁移）；model 表不加 teamId（通过 provider 间接关联）。

---

## 任务索引

### Task 0: 环境准备
验证构建工具链和测试环境是否就绪。

### Task 1: 数据库 Schema 扩展
为 11 张资源表添加 `teamId` 列（NOT NULL），扩展 session 表支持 `activeTeamId`，更新 initDb 建表语句。

### Task 2: AuthContext 定义与团队服务层
定义 AuthContext 接口，创建 team.ts 服务层（CRUD + 成员管理 + 注册时自动创建个人团队），改造 authGuardPlugin 加载团队上下文。

### Task 3: Config 服务层 AuthContext 适配
将所有 config 服务函数签名从 `(userId, ...)` 改为 `(ctx: AuthContext, ...)`，查询条件从 `WHERE user_id = ?` 改为 `WHERE team_id = ?`。

### Task 4: Web 路由 AuthContext 适配与团队 API
更新所有 web 路由 handler 使用 `store.authContext`，新增团队管理 API 路由，注册到主应用。

### Task 5: 前端团队功能（Context + Switcher + 管理页面）
创建 TeamContext、TeamSwitcher 组件、TeamsPage 页面，改造 Sidebar 和 App.tsx。

### Acceptance Task
端到端验证所有功能是否正确实现。

---

## Task 0: 环境准备

**执行步骤:**
- [x] 验证后端类型检查 (`bun run typecheck`)
- [x] 验证测试套件可运行 (`bun test src/__tests__/`)
- [x] 验证前端构建 (`bun run build:web`)

---

## Task 1: 数据库 Schema 扩展

**背景:** 为所有资源表添加 `teamId` 外键（NOT NULL），session 表添加 `activeTeamId`。`team` 和 `team_member` 表已存在。

**涉及文件:**
- 修改: `src/db/schema.ts`
- 修改: `src/db/index.ts`

**执行步骤:**

- [x] `src/db/schema.ts` — session 表添加 `activeTeamId`:
  ```typescript
  activeTeamId: uuid("active_team_id").references(() => team.id, { onDelete: "set null" }),
  ```

- [x] `src/db/schema.ts` — 11 张��源表添加 `teamId`（NOT NULL，在 userId 字段后）:
  ```typescript
  teamId: uuid("team_id").notNull().references(() => team.id, { onDelete: "cascade" }),
  ```
  涉及表: provider, agentConfig, mcpServer, skill, userConfig, apiKey, scheduledTask, environment, knowledgeBase, imChannel, workflow
  注意: `model` 表不加 teamId

- [x] `src/db/index.ts` — 更新 initDb() 中对应表的 CREATE TABLE 语句，添加 team_id 和 active_team_id 列

- [x] 编写 schema 验证测试 `src/__tests__/team-schema.test.ts`

**检查步��:**
- [x] `grep -c "teamId" src/db/schema.ts` >= 11
- [x] `grep "activeTeamId" src/db/schema.ts` 匹配 1 行
- [x] `bun run typecheck` 无错误（非测试代码 0 错误）

---

## Task 2: AuthContext 定义与团队服务层

**背景:** 定义 AuthContext 接口，创建团队服务，改造 authGuardPlugin 在认证成功后自动加载团队上下文。

**涉及文件:**
- 新建: `src/services/team.ts`
- 修改: `src/plugins/auth.ts`

**执行步骤:**

- [ ] `src/plugins/auth.ts` — 定义 AuthContext 接口并扩展 store:
  ```typescript
  export interface AuthContext {
    teamId: string;
    userId: string;
    role: "owner" | "admin" | "member";
  }
  ```
  - state 追加 `authContext: null as AuthContext | null`
  - sessionAuth 宏 beforeHandle: 认证成功后调用 `getAuthContext`，若无活跃团队则 `ensurePersonalTeam` 后重试

- [ ] 创建 `src/services/team.ts`（12 个函数）:
  - `listMyTeams(userId)` — 用户加入的团队列表
  - `getTeamDetail(teamId)` — 团队详情
  - `createTeam(userId, name, slug, description)` — 创建团队 + 自动加为 owner
  - `ensurePersonalTeam(userId)` — 自动创建个人团队（slug = 'personal-' + userId，幂等）
  - `switchTeam(userId, sessionId, teamId)` — 切换活跃团队
  - `addMember(teamId, targetUserId, role)` — 添加成员
  - `removeMember(teamId, targetUserId)` — 移除成员（不能移除最后一个 owner）
  - `updateRole(teamId, targetUserId, newRole)` — 修改角色（保留至少一个 owner）
  - `getAuthContext(userId, sessionId)` — 从 session 读取 activeTeamId + 查角色
  - `getTeamMembers(teamId)` — 成员列表（JOIN user）
  - `updateTeam(teamId, data)` — 更新团队信息
  - `deleteTeam(teamId)` — 删除团队

- [ ] 编写单元测试 `src/__tests__/team-service.test.ts`

**检查步骤:**
- [ ] `grep "export interface AuthContext" src/plugins/auth.ts` 匹配
- [ ] `ls src/services/team.ts` 存在
- [x] `bun run typecheck` 无错误（非测试代码 0 错误）

**TRAP:** better-auth 不支持自定义 session 字段自动管理，`activeTeamId` 通过 Drizzle 直接操作 session 表。

---

## Task 3: Config 服务层 AuthContext 适配

**背景:** 最大改动量。所有 config 服务函数签名从 `userId` 改为 `AuthContext`，查询从 `user_id` 改为 `team_id`。

**涉及文件:**
- 修改: `src/services/config/provider.ts`
- 修改: `src/services/config/agent-config.ts`
- 修改: `src/services/config/mcp-server.ts`
- 修改: `src/services/config/skill.ts`
- 修改: `src/services/config/user-config.ts`
- 修改: `src/services/config/aggregate.ts`
- 修改: `src/services/config/index.ts`（导出 AuthContext）

**执行步骤:**

- [ ] `src/services/config/index.ts` — 导出 AuthContext 类型

- [ ] 适配 `provider.ts`（代表性模式，其余文件同）:
  - `listProviders(userId)` -> `listProviders(ctx: AuthContext)` — `eq(provider.teamId, ctx.teamId)`
  - `upsertProvider(userId, name, data)` -> `upsertProvider(ctx, name, data)` — values 加 `teamId: ctx.teamId`，conflict target 改 `[provider.teamId, provider.name]`
  - `deleteProvider(userId, name)` -> `deleteProvider(ctx, name)`

- [ ] 适配 `agent-config.ts`、`mcp-server.ts`、`skill.ts` — 同 provider 模式

- [ ] 适配 `user-config.ts` — userConfig PK 改为 teamId

- [ ] 适配 `aggregate.ts` — 所有 `eq(x.userId, userId)` 改为 `eq(x.teamId, ctx.teamId)`

- [ ] 编写测试 `src/__tests__/config-auth-context.test.ts`

**检查步骤:**
- [ ] `grep -c "userId: string" src/services/config/*.ts` = 0
- [x] `bun run typecheck` 无错误（非测试代码 0 错误）

**TRAP:** provider 唯一约束从 `(userId, name)` 改为 `(teamId, name)`，onConflictDoUpdate target 必须同步更新。

---

## Task 4: Web 路由 AuthContext 适配与团队 API

**涉及文件:**
- 新建: `src/routes/web/teams.ts`
- 修改: 所有 `src/routes/web/config/*.ts`
- 修改: `src/routes/web/environments.ts`, `sessions.ts`, `tasks.ts`, `channels.ts`, `api-keys.ts`, `knowledge-bases.ts`
- 修改: `src/index.ts`

**执行步骤:**

- [ ] 创建 `src/routes/web/teams.ts` — POST + action 分发
  - Actions: list, get, create, update, delete, switch, list-members, add-member, remove-member, update-role, get-current
  - 权限: owner/admin 管理成员，owner only 修改角色/删除团队

- [ ] 适配所有 web 路由 — `store.user!.id` -> `store.authContext!`

- [ ] `src/index.ts` 注册团队路由

- [ ] 编写测试 `src/__tests__/team-routes.test.ts`

**检查步骤:**
- [ ] `grep -rn "store\.user!\.id" src/routes/web/ | wc -l` = 0
- [ ] `ls src/routes/web/teams.ts` 存在
- [x] `bun run typecheck` 无错误（非测试代码 0 错误）

---

## Task 5: 前端团队功能

**涉及文件:**
- 新建: `web/src/contexts/TeamContext.tsx`
- 新建: `web/src/components/TeamSwitcher.tsx`
- 新建: `web/src/pages/TeamsPage.tsx`
- 修改: `web/src/components/shell/Sidebar.tsx`
- 修改: `web/src/App.tsx`

**执行步骤:**

- [ ] 创建 `TeamContext.tsx` — TeamProvider + useTeam() hook

- [ ] 创建 `TeamSwitcher.tsx` — 当前团队名 + 下拉菜单（团队列表 + 创建 + 管理链接）

- [ ] 创建 `TeamsPage.tsx` — 左右分栏（团队列表 + 详情面板：名称/描述编辑 + 成员管理 + 删除）

- [ ] 修改 `Sidebar.tsx` — Brand 区域插入 TeamSwitcher，NAV_GROUPS 添加 `{ id: "teams", label: "团队", icon: Users }`

- [ ] 修改 `App.tsx` — TeamProvider 包裹 + TeamsPage 路由

- [ ] `bun run build:web` 构建验证

**检查步骤:**
- [ ] 所有新文件存在
- [ ] Sidebar 包含 TeamSwitcher 和 teams 导航
- [ ] `bun run build:web` 成功

**TRAP:** 团队切换用 `window.location.reload()` 硬刷新。

---

## Acceptance Task

- [ ] `bun test src/__tests__/` 全部通过
- [x] `bun run typecheck` 无错误（非测试代码 0 错误）
- [ ] `bun run build:web` 成功
- [ ] 新注册用户自动创建个人团队
- [ ] Sidebar 显示团队切换器 + "团队"导航
- [ ] 团队 CRUD + 成员管理
- [ ] 团队切换后数据刷新
- [ ] 权限控制: member 不能管理成员，非 owner 不能删除团队
