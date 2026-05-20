# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

Remote Control Server (RCS) 是一个基于 Elysia + Bun 的 AI Agent 控制面板后端（package name: `mothership`），配合 React + Vite 前端，使用 PostgreSQL + Drizzle ORM 持久化。核心功能包括：

- **ACP 协议支持**：通过 WebSocket 与 acp-link Agent通信，实现远程 Agent 控制和事件流转发
- **配置管理**：Providers/Models/Agents/Skills/MCP 的动态配置，存储于 PostgreSQL（`src/services/config/` 子模块）
- **多租户**：better-auth organization 插件实现多组织隔离，所有配置和资源以 `organizationId` 为范围，通过 `AuthContext` 传递
- **会话管理**：通过 SSE 向前端推送会话事件（user/assistant/tool_use/permission_request 等），支持 ACP session/list 按 cwd 过滤
- **认证授权**：better-auth (PostgreSQL) + `@better-auth/api-key` 插件，支持用户会话和 acp-link 的 Bearer token。Organization 插件提供多租户隔离，API Key 插件提供 per-user key 管理
- **定时 HTTP 任务**：cron 调度、执行历史记录、失败重试（Drizzle ORM + node-schedule）
- **用户文件系统**：会话级文件读写上传，支持 iframe 预览（`/web/sessions/:id/user/*`）
- **Channel 层**：多频道通信支持（`/web/channels`）
- **会话分享**：share link 表已创建（readonly/writable 模式），功能开发中
- **Workspace Packages**：`packages/` 下有 acp-link、core、plugin-sdk、opencode 四个内部包，通过 Bun workspaces + tsconfig paths 管理
- **知识库**：知识库管理（`src/services/knowledge-base.ts`），通过 provider 抽象（`src/services/knowledge-provider/`）对接外部知识服务
- **工作流引擎**：完整的 DAG 工作流引擎（`@mothership/workflow-engine`），支持 YAML 定义、多种节点执行器（Shell/Python/Agent/API/Audit/Loop/SubWorkflow）、快照恢复、secrets/inputs 解析，前端使用 React Flow 可视化编辑
- **Meta Agent**：元智能体服务（`src/services/meta-agent.ts`），负责智能体编排和场景提示词注入

## 常用命令

### 开发与构建

```bash
# 后端开发（热重载）
bun run dev

# 前端开发（Vite dev server，独立进程，Agent到后端）
bun run dev:web

# 生产构建前端（修改前端代码后必须执行！）
bun run build:web

# 启动生产服务器
bun run start

# 类型检查
bun run typecheck

# Biome lint 检查
bun run lint

# Biome 自动格式化
bun run format

# 依赖健康检查
bun run check:deps

# 数据库 schema 同步（开发环境，直接推送 schema.ts 到 DB）
bun run db:push

# 生成迁移文件（修改 schema.ts 后执行）
bun run db:generate --name <描述性名称>

# 应用迁移文件（生产环境）
bun run db:migrate
```

**重要**：
- 后端通过 `serveStatic` 挂载 `web/dist/` 目录（见 `src/index.ts`）。修改任何前端代码后，**必须**执行 `bun run build:web` 重新构建，否则更改不会生效。
- `initDb()` 不再包含手写 SQL，只验证数据库连接。所有 schema 变更通过 `bun run db:push`（开发）或 `bun run db:migrate`（生产）同步。**严禁在 `src/db/index.ts` 中添加手写建表 SQL。**
- **环境变量校验**：`src/env.ts` 使用 Zod（`zod/v4`）在启动时校验所有环境变量。`src/config.ts` 的 `buildConfig(env)` 函数接收校验后的 env 对象。新增环境变量必须先在 `src/env.ts` 的 `envSchema` 中声明
- **代码质量工具**：项目使用 Biome（v2.4.15）统一处理 lint + format（配置见 `biome.json`），不使用 ESLint/Prettier。运行 `bun run lint` 检查，`bun run format` 自动格式化
- **Swagger API 文档**：`@elysiajs/swagger` 插件已挂载在 `/docs/swagger`，从 Elysia 路由自动生成交互式 API 文档。新增路由时添加 `.tags()` 分组

### 测试

```bash
# 运行所有后端测试（Bun test）
bun test src/__tests__

# 运行特定测试文件
bun test src/__tests__/config-providers.test.ts

# 前端全部测试（从项目根目录运行）
bun test web/src/__tests__/

# 前端单个测试文件
bun test web/src/__tests__/config-mcp-page.test.ts
```

**注意**：前端代码在 `web/` 目录，但没有独立的 `package.json`。所有依赖在根目录 `package.json`，构建命令需要从项目根目录执行。前端测试使用 `import.meta.dirname` 解析文件路径，从项目根目录运行即可。

### 测试账号

本地开发环境的测试账号（通过 better-auth 注册）：

- **邮箱**：`admin@test.com`
- **密码**：`admin123456`

### 工作目录注意事项

Bash 的 `cd` 命令会改变 persistent CWD。当在 `web/` 目录执行命令后，后续相对路径会出错。解决方案：

- 使用绝对路径
- 或在每次命令前重新 `cd` 到项目根

```bash
# 错误示例
cd web && bunx vite build && ls src/  # 这里的 src/ 是相对于 web/ 的

# 正确示例
cd web && bunx vite build && cd .. && ls src/
```

## 架构关键点

### 后端架构 (Elysia + Bun)

**入口**：`src/index.ts`

- 挂载所有路由：`/v1/*`（兼容）、`/web/*`（控制面板 API）、`/acp/*`（ACP 协议）
- 静态文件服务：`/ctrl/*` → `web/dist/`（构建后的前端）
- iframe 预览重定向：`/ctrl/:sessionId/user/*` → `/web/sessions/:id/user/*?preview=true`
- 启动时初始化：环境变量校验（`validateEnv` + `applyEnv`）、skills 目录迁移（`migrateSkillsDir`）、定时任务调度器（`startScheduler`）
- Swagger API 文档：`/docs/swagger`（`@elysiajs/swagger` 插件自动生成）
- 请求限流：IP 级别滑动窗口限流（100 req/min），`src/plugins/rate-limit.ts`
- 请求体大小限制：10MB
- 优雅关闭：清理 WebSocket 连接、instances、调度器

**认证层**：

- `src/auth/better-auth.ts`：better-auth 实例，配置 `organization` + `apiKey` 插件，使用 Drizzle adapter + PostgreSQL schema
- `src/auth/jwt.ts`：JWT 工具（worker token 生成）
- `src/auth/token.ts`：token 辅助工具
- `src/services/org-context.ts`：组织上下文加载（`loadOrgContext`），从请求中解析 activeOrganizationId，通过 better-auth organization API 查角色，无组织时返回 null
- `src/plugins/auth.ts`：Elysia 插件，`authGuardPlugin`（macro 方式提供 `sessionAuth` 装饰器）+ `AuthContext` 类型（`organizationId`/`userId`/`role`）

**配置服务**：`src/services/config/`（`config-pg.ts` 为兼容桶文件，re-export 所有函数）

- 存储：PostgreSQL 数据库，6 张配置表（provider, model, agent_config, mcp_server, skill, user_config）
- 多租户：所有 CRUD 函数以 `ctx: AuthContext`（含 `organizationId`/`userId`/`role`）为首参数，WHERE 条件包含 `organization_id`
- 子模块拆分：`provider.ts`、`model.ts`、`agent-config.ts`、`mcp-server.ts`、`skill.ts`、`user-config.ts`、`aggregate.ts`（批量配置聚合）
- JSONB 字段：permission、knowledge、config 等复杂结构用 JSONB 存储
- 返回值约定：delete → boolean（`.returning()` 检查长度），get → 对象 | null，list → 数组
- **其他服务**：`skill.ts`（skill-fs）、`instance.ts`、`task.ts`、`scheduler.ts`、`session.ts`、`environment.ts` 负责特定功能的 CRUD 和调度
- **工作流服务**：`src/services/workflow/`（`workflow-fs.ts` YAML 读写、`pg-storage-adapter.ts` PG 持久化、`acp-transport.ts` Agent 通信传输）
- **Meta Agent 服务**：`src/services/meta-agent.ts`（元智能体编排 + 场景提示词注入）

**传输层**：`src/transport/`

- `acp-ws-handler.ts`：处理 `/acp/ws` 连接（acp-link 注册）
- `acp-relay-handler.ts`：处理 `/acp/relay/:agentId` 连接（前端与 Agent 的中继），拦截 `list_sessions` 由服务端直接响应
- `acp-sse-writer.ts`：ACP SSE 事件写入
- `event-bus.ts`：事件总线，连接会话事件和 ACP 连接
- `sse-writer.ts`：SSE 事件规范化
- `ws-handler.ts`：通用 WebSocket 处理
- `ws-types.ts`：WebSocket 类型定义
- `client-payload.ts`：客户端消息载荷处理

**Elysia 插件层**：`src/plugins/`

- `auth.ts`：`authGuardPlugin`（提供 `sessionAuth` macro）+ `authPlugin`（better-auth 路由）+ `AuthContext` 类型
- `cors.ts`：跨域配置
- `error-handler.ts`：全局错误处理（`AppError` → HTTP 状态码映射）
- `logger.ts`：结构化请求日志（`createLogger()` 工厂，requestId 跟踪）
- `rate-limit.ts`：IP 级别滑动窗口限流（100 req/min，测试环境自动跳过）
- `static.ts`：静态文件挂载
- `require-team-scope.ts`：统一组织级资源归属校验 helper（`requireOrgScope`），验证 environment→organization 链路所有权（文件名保留历史兼容，内容已迁移到 organization）

**Repository 层**：`src/repositories/`（数据访问抽象，介于 services 和 DB 之间）

- `environment.ts`：环境持久化 CRUD（`IEnvironmentRepo` 接口）
- `session.ts`：会话记录（`ISessionRepo`）
- `session-worker.ts`：Worker 状态
- `task.ts`：定时任务 + 执行日志（`IScheduledTaskRepo`、`ITaskExecutionLogRepo`）
- `knowledge-base.ts`：知识库 + 资源 + Agent 绑定
- `share-link.ts`：分享链接
- `token.ts`：遗留 token 存储
- `work-item.ts`：工作项
- `channel-binding.ts`：频道绑定
- `index.ts`：桶文件，统一 re-export 所有 repo 实例和类型

**错误类**：`src/errors.ts`

- `AppError`：基础错误类（`message`、`code`、`statusCode`）
- `ValidationError`：400
- `NotFoundError`：404
- `ConflictError`：409

**内存存储**：`src/store.ts`

- `environments` Map：Agent 注册信息（断开时直接删除，不保留 offline）
- `sessions` Map：会话元数据（environment 删除时关联 session 也会被删除）
- `sessionWorkers` Map：Worker 状态（`storeGetSessionWorker`、`storeUpsertSessionWorker`）
- `tokens` Map：遗留 token 存储（`storeCreateToken`、`storeGetUserByToken`）
- 辅助查询：`storeListSessionsForAgentByCwd`（按 cwd 过滤 session）、`storeListAcpAgentsByUserId`

**数据库持久化**：`src/db/schema.ts`（Drizzle ORM + PostgreSQL）

- better-auth 核心表：`user`、`session`、`account`、`verification`
- better-auth organization 插件表：`organization`、`member`、`invitation`
- better-auth api-key 插件表：`apikey`（key 存储、rate limit、metadata 等）
- 自定义表：`mcpTool`、`scheduledTask`、`taskExecutionLog`、`shareLink`、`shareEventSnapshot`、`environment`
- 配置表（F002）：`provider`、`model`、`agentConfig`、`mcpServer`、`skill`、`userConfig`

### ACP 协议要点

acp-link 是连接 AI Agent 和 RCS 的桥梁，通过 WebSocket 进行双向通信。

#### 认证方式

acp-link 有两种认证方式（优先级从高到低）：

1. **better-auth API Key**（`@better-auth/api-key` 插件，`apikey` 表）：`Authorization: Bearer rcs_xxx` 或 `?token=rcs_xxx`。通过 `auth.api.verifyApiKey({ body: { key: token } })` 验证
2. **全局 API Key**（环境变量）：`RCS_API_KEYS=key1,key2`，回退到系统用户

#### WebSocket 端点

**`/acp/ws`** — acp-link 注册端点

- 认证：API Key（Bearer token 或 query param）
- 消息格式：NDJSON（每行一个 JSON + `\n`）

**关键消息类型**：

```json
// acp-link 发送注册请求
{"type": "register", "agent_name": "my-agent", "max_sessions": 1, "capabilities": {...}}

// 服务器响应注册成功
{"type": "registered", "agent_id": "env_xxx"}

// acp-link 也可以先通过 REST 注册，再通过 WS 绑定
{"type": "identify", "agent_id": "env_xxx"}

// 保活（双向）
{"type": "keep_alive"}

// 任意业务消息（透传到 EventBus）
{"type": "user", "content": "..."}
```

**`/acp/relay/:agentId`** — 前端与 Agent 的中继端点

- 认证：better-auth session（cookie-based）
- 用途：前端通过此 WebSocket 与 acp-link 通信，服务器双向转发消息
- `keep_alive` 消息在 relay 层被拦截，不透传到前端（防止 "Unknown message type: keep_alive" 错误）
- `list_sessions` 消息由 relay 层拦截，服务端直接按 ACP `AgentSessionInfo` 格式响应（支持 `cwd` 过滤）
- relay 断连时不关闭 acp-link 子进程（只关闭 WebSocket 连接），仅用户显式删除时才终止进程
- 多实例隔离：relay URL 携带 `?sessionId=xxx` 参数，`agentLocalWsMap` 按 **instanceId** 做 key（非 agentId），同一环境多个实例各有独立的本地 WS 连接
- 消息流向：
  - 前端 → relay → acp-link（`direction: "outbound"`）
  - acp-link → relay → 前端（`direction: "inbound"`）

#### REST 注册端点（必须）

**`/v1/environments/bridge`** — acp-link 标准 REST 注册

- **POST**：注册新 agent，返回 `environment_id` 和 `session_id`
- **DELETE** `/bridge/:id`：注销 agent
- **POST** `/:id/bridge/reconnect`：重连（标记 status 为 `active`）

**acp-link 标准连接流程**：

1. REST POST `/v1/environments/bridge` → 获取 `environment_id`
2. WebSocket 连接 `/acp/ws?token=xxx`
3. 发送 `{"type": "identify", "agent_id": "env_xxx"}` 绑定连接

#### 保活机制

| 方向 | 间隔 | 说明 |
|------|------|------|
| 服务器 → acp-link | 20s | `keep_alive` 数据帧，防止反向Agent超时断开 |
| acp-link → 服务器 | 60s | 无活动则关闭连接（检测死连接） |
| 服务器 → 前端 relay | 20s | `keep_alive` 保持 relay 连接 |

#### 连接状态管理

- **注册**：创建 `EnvironmentRecord`（`workerType="acp"`），状态为 `active`
- **断开**：WS 断开时**直接删除内存记录和关联 session**（不保留 offline 状态），但 acp-link 子进程不会被杀掉（除非用户显式删除）
- **注销**：DELETE `/v1/environments/bridge/:id` 直接删除记录（不是标记 `deregistered`）
- **自动会话**：注册时若无 session，自动创建一个默认 session
- **超时清理**：`disconnect-monitor` 检测到 ACP agent 超时也会直接删除记录

### Workspace Packages

项目使用 Bun workspaces，`packages/` 下有 4 个内部包（均 `private: true`，通过 `tsconfig.base.json` 的 `paths` 做 TypeScript 路径映射）：

- **`acp-link`**（`packages/acp-link/`）：ACP stdio-to-WebSocket 桥接器，spawn 一个 ACP agent 并通过 WebSocket 暴露。包含 CLI、client、server 端代码
- **`@mothership/core`**（`packages/core/`）：核心运行时抽象 — 类型定义（`types/`）、注册表（`registry/`：core-node、engine-plugin）、运行时编排（`runtime/`：instance-orchestrator）、门面（`facade/`）
- **`@mothership/plugin-sdk`**（`packages/plugin-sdk/`）：插件开发 SDK — engine-plugin 接口、engine-relay 接口、agent-launch-spec 类型
- **`@mothership/opencode`**（`packages/plugin-opencode/`）：opencode 引擎插件实现，依赖 core 和 plugin-sdk
- **`@mothership/workflow-engine`**（`packages/workflow-engine/`）：工作流引擎核心 — YAML 解析器（`parser/`）、DAG 调度器（`scheduler/`）、节点执行器（`executor/`：Shell/Python/Agent/API/Audit/Loop/SubWorkflow）、快照恢复（`recovery/`）、secrets 解析（`secrets/`）、存储适配器（`storage/`）、引擎门面（`engine/`）

### 前端架构 (React + Vite + TanStack Router)

**构建配置**：`web/vite.config.ts`

- Tailwind CSS v4 使用 `@tailwindcss/vite` 插件（**不是** tailwind.config.js）
- TanStack Router 使用 `@tanstack/router-plugin/vite` 插件（file-based routing，**必须**在 plugins 数组第一位）
- base path: `/ctrl/`，TanStack Router `basepath: '/ctrl'`
- 路径别名：`@/src` → `web/src`，`@/components` → `web/components`，`@server` → `../../src`（前端引用后端类型）
- 开发代理：`/web`、`/api`、`/acp` → `http://localhost:3000`

**样式系统**：`web/src/index.css`

- Tailwind v4 with `@theme` directive
- `@plugin "@tailwindcss/typography"` 用于 prose 类
- 颜色系统：brand blue (#409EFF)，深色侧边栏 (#1a1f2e)

**路由架构**：TanStack Router file-based routing（`web/src/routes/`）

入口：`web/src/main.tsx` → `createRouter({ routeTree, basepath: '/ctrl' })` + `<RouterProvider />`

路由树结构：

```
web/src/routes/
├── __root.tsx              → ThemeProvider + OrgProvider + 认证检查（useSession）+ Toaster
├── _app.tsx                → pathless layout：AppShell（Sidebar + Topbar），动态 overflow 样式
├── _app/
│   ├── index.tsx           → Dashboard              /ctrl/
│   ├── models.tsx          → ModelsPage             /ctrl/models
│   ├── agents.tsx          → AgentsPage             /ctrl/agents
│   ├── skills.tsx          → SkillsPage             /ctrl/skills
│   ├── knowledge-bases.tsx → KnowledgeBasesPage     /ctrl/knowledge-bases
│   ├── mcp.tsx             → McpPage                /ctrl/mcp
│   ├── tasks.tsx           → TasksPage              /ctrl/tasks
│   ├── channels.tsx        → ChannelsPage           /ctrl/channels
│   ├── workflow.tsx        → WorkflowPage            /ctrl/workflow
│   ├── workflow_.$.tsx     → WorkflowPage catch-all  /ctrl/workflow/*
│   ├── environments.tsx    → EnvironmentsPage        /ctrl/environments
│   ├── organizations.tsx   → OrgsPage               /ctrl/organizations
│   ├── apikeys.tsx         → ApiKeyManager           /ctrl/apikeys
│   └── $sessionId.tsx      → SessionDetail           /ctrl/:sessionId
├── agent/
│   ├── $agentId.tsx        → AgentAppShell           /ctrl/agent/:agentId
│   └── $agentId_.$sessionId.tsx → AgentAppShell      /ctrl/agent/:agentId/:sessionId
└── login.tsx               → LoginPage               /ctrl/login
```

路由关键约定：
- `_app` 是 pathless layout（`_` 前缀），不贡献 URL 段，只提供 AppShell 布局
- `_` 后缀（如 `workflow_.$`、`$agentId_.$sessionId`）表示 flat route，不嵌套布局
- `$` 前缀是动态参数，`$` 单独（无名称）是 splat catch-all
- `__root.tsx` 统一处理认证：未登录 redirect `/login`，已登录在 `/login` redirect `/`
- `routeTree.gen.ts` 由 Vite 插件自动生成，**严禁手动编辑**
- 所有页面组件 lazy 加载（`lazy(() => import(...))`）
- 新增页面：在 `web/src/routes/_app/` 下创建路由文件，插件自动注册

**组件层级**：

- `web/src/main.tsx`：TanStack Router 初始化 + `<RouterProvider />`
- `web/src/App.tsx`：仅保留 `parseConfigView` 工具函数（测试依赖）
- `web/src/routes/`：路由定义文件（每个文件 = 一个路由）
- `web/src/components/shell/`：AppShell（collapsed/onToggle/children）、Sidebar（`<Link>` + `useRouterState`）、Topbar（`useRouterState` 推导面包屑）
- `web/src/components/config/`：DataTable、FormDialog、StatusBadge（配置页通用组件）
- `web/src/components/`：FilePickerDialog、PermissionTab、SessionDetail 等功能组件
- `web/src/pages/`：Dashboard、ModelsPage、AgentsPage 等页面组件（不接收导航回调，用 `useNavigate()` 自主导航）
  - `web/src/pages/agent-panel/`：AgentAppShell（从路由参数读取 agentId/sessionId）
  - `web/src/pages/workflow/`：WorkflowPage（保留内部子路由，使用 `window.location.pathname` 自行解析）
- `web/src/acp/`：ACP 客户端（`client.ts`、`relay-client.ts`、`types.ts`），处理 session/list、session/load、session/resume 等 ACP 协议

**导航方式**：

- 声明式：`<Link to="/models">`（Sidebar 导航项）
- 编程式：`useNavigate()` — `void navigate({ to: '/$sessionId', params: { sessionId }, search: { cwd, agentId } })`
- 路由参数：`Route.useParams()` 获取动态参数（如 `sessionId`、`agentId`）
- 路由状态：`useRouterState()` 获取当前 pathname（Topbar 面包屑、Sidebar 高亮）
- **禁止**使用 `window.history.pushState` 或 `window.location.href` 进行导航

**状态管理**：

- 本地状态：useState + useCallback
- 远程数据：API client (`web/src/api/client.ts`) + fetch
- 认证状态：better-auth session（cookie-based）
- 路由状态：TanStack Router（pathname、params、search）

**API Client 模式**：

```typescript
async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    credentials: "include", // 关键：携带 better-auth session cookie
    body: body ? JSON.stringify(body) : undefined,
  });
  // ...错误处理
}
```

### 前端 i18n 国际化

前端使用 **react-i18next + i18next** 实现中英双语国际化，英文为默认语言。

**初始化**：`web/src/i18n/index.ts` — i18next 配置中心，在 `main.tsx` 中优先导入

- **语言检测**：`i18next-browser-languagedetector`，优先读取 localStorage（key: `rcs-lang`），回退到 `navigator.language`
- **默认语言**：`fallbackLng: "en"`，中文缺失时回退英文
- **命名空间**：17 个按模块划分的 namespace，常量定义在 `NS` 对象中

**命名空间列表**：

| Namespace | 文件 | 覆盖范围 |
|-----------|------|---------|
| `common` | `common.json` | 通用按钮/状态/错误/时间 |
| `sidebar` | `sidebar.json` | 侧边栏导航项/标签 |
| `login` | `login.json` | 登录/注册表单 |
| `dashboard` | `dashboard.json` | 系统概览页 |
| `agents` | `agents.json` | Agent 配置页 |
| `models` | `models.json` | 模型配置页 |
| `skills` | `skills.json` | Skill 管理页 |
| `mcp` | `mcp.json` | MCP 服务器配置页 |
| `tasks` | `tasks.json` | 定时任务页 |
| `workflows` | `workflows.json` | 工作流编辑器/列表/运行/版本 |
| `sessions` | `sessions.json` | 会话详情/事件流 |
| `environments` | `environments.json` | 环境管理页 |
| `orgs` | `orgs.json` | 组织管理页 |
| `apikey` | `apikey.json` | API Key 管理页 |
| `channels` | `channels.json` | 消息渠道页 |
| `knowledge` | `knowledge.json` | 知识库页 |
| `agentPanel` | `agentPanel.json` | Agent 面板侧栏/聊天 |
| `components` | `components.json` | 共享组件（Navbar/Permission/FilePicker 等） |

**翻译文件位置**：
- 英文：`web/src/i18n/locales/en/<namespace>.json`
- 中文：`web/src/i18n/locales/zh/<namespace>.json`

**使用方式**：

```typescript
// React 组件内（推荐）
const { t } = useTranslation("namespace");
<p>{t("section.key")}</p>

// 带插值
<p>{t("items.count", { count: 42 })}</p>

// 跨命名空间引用
const { t } = useTranslation("dashboard");
<p>{t("common:loading")}</p>
```

**语言切换**：`web/src/i18n/LanguageSwitcher.tsx` — Topbar 中的 Globe 按钮，切换 "EN"/"中文"

**新增页面 i18n 步骤**：
1. 创建 `web/src/i18n/locales/en/<namespace>.json` 和 `zh/<namespace>.json`
2. 在 `web/src/i18n/index.ts` 中添加 import、`NS` 常量、resources 注册、ns 数组
3. 页面组件中 `const { t } = useTranslation("<namespace>")` + 替换硬编码文本

**禁止事项**：
- 前端源文件中不得出现硬编码的中文字符串（注释除外）
- 不得直接 `import i18n from "i18next"` 在模块级调用 `i18n.t()`（应通过 `useTranslation` hook 或参数传递 `t` 函数）
- 不得创建新的顶层 `*-i18n.test.ts` 测试文件（旧文件已删除）

## 配置存储

配置数据存储在 PostgreSQL 中，通过 `src/services/config/` 子模块管理（`config-pg.ts` 为兼容桶文件）。旧版文件 `~/.config/opencode/opencode.json` 已废弃。

### 配置 API 规范

**统一格式**：`POST /web/config/:module`

| Module | 说明 |
|--------|------|
| `providers` | AI 服务商管理 |
| `models` | 模型配置 |
| `agents` | Agent 配置 |
| `skills` | Skill 管理 |
| `mcp` | MCP 服务器配置 |

**请求格式**：

```jsonc
{
  "action": "list" | "get" | "set" | "create" | "delete" | "enable" | "disable",
  // ... 其他字段按 action 而定
}
```

**响应格式**：

```jsonc
// 成功
{ "success": true, "data": { ... } }

// 失败
{ "success": false, "error": { "code": "NOT_FOUND", "message": "..." } }
```

**错误码**：`NOT_FOUND`、`ALREADY_EXISTS`、`VALIDATION_ERROR`、`CONFIG_READ_ERROR`、`CONFIG_WRITE_ERROR`、`FORBIDDEN`

### API Key 安全策略

- API Key 由 `@better-auth/api-key` 插件管理，存储在 `apikey` 表中
- Key 以 base64url 编码的 SHA-256 hash 存储（`key` 列），配合 `prefix`（前几位字符）用于展示
- 验证通过 `auth.api.verifyApiKey({ body: { key: token } })` 进行
- 创建时返回完整明文 key（仅此一次），后续 API 响应只返回 `prefix` 作为 hint
- 支持 rate limiting（`rateLimitEnabled`/`rateLimitTimeWindow`/`rateLimitMax`）和 metadata（需 `enableMetadata: true`）
- Provider API Key（非 RCS 自身 API Key）仍使用 `{env:RCS_SECRET_<name>}` 占位符模式，密文存环境变量

### better-auth 服务端 API 调用约定

better-auth 的 `auth.api` 方法在服务端调用时，所有参数必须通过**单参数对象**传递，POST 端点的业务数据需嵌套在 `body` 属性中：

```typescript
// POST 端点 — body 嵌套
await auth.api.createOrganization({
  body: { name: "Personal", slug: "personal-xxx" },
  headers: request.headers,
});
await (auth.api as any).createApiKey({
  body: { name: "Meta Agent", prefix: "rcs_", expiresIn: null },
  headers: request.headers,
});

// GET 端点 — 直接传 query/headers
await auth.api.listOrganizations({ headers: request.headers });
await auth.api.listMembers({ query: { organizationId: orgId }, headers: request.headers });
```

- **`expiresIn` 单位是天**（不是秒），默认最小值 1 天，传 `null` 表示永不过期
- **`listMembers` 返回 `{ members, total }`**，不是数组，需用 `res.members` 取成员列表
- 所有需要 session 的 API 必须传入 `headers: request.headers` 以携带 session cookie

### Skills 存储路径

```
~/.agents/skills/           ← Skill Markdown 内容文件
```

- **元数据**（name, description, enabled 等）存储在 PostgreSQL `skill` 表中
- **内容**（Markdown）保留在文件系统 `~/.agents/skills/<name>/SKILL.md`
- 启用/禁用通过数据库 `enabled` 字段控制，不再通过目录移动
- 旧路径 `~/.config/opencode/skills/` 和 `_disabled/` 目录已废弃

### Permission 权限系统

Agent 权限从旧版 `tools`（布尔值）升级为 `permission`（三态）：

| 旧格式 | 新格式 |
|--------|--------|
| `tools: { bash: true, edit: false }` | `permission: { bash: "allow", edit: "deny" }` |

**权限值**：

- `"ask"` — 询问用户
- `"allow"` — 允许
- `"deny"` — 拒绝

**工具类型**：

- **规则型**（支持通配符）：read, edit, glob, grep, list, bash, task, external_directory, lsp, skill
- **开关型**（仅三态）：todowrite, question, webfetch, websearch, codesearch, doom_loop

**示例**：

```jsonc
{
  "permission": {
    "bash": "allow",              // 全局允许
    "read": { "*.env": "deny" },  // 通配符规则
    "skill": { "internal-*": "allow" }
  }
}
```

### 内置 Agent 保护

以下 Agent 为内置，不可删除（可修改配置）：

- `build`、`plan`、`general`、`explore`、`title`、`summary`、`compaction`

### MCP 服务器配置

MCP (Model Context Protocol) 支持两种类型：

**Local**（命令行启动）：

```jsonc
{
  "type": "local",
  "command": ["npx", "-y", "@modelcontextprotocol/server-github"],
  "environment": { "GITHUB_TOKEN": "{env:GITHUB_TOKEN}" },
  "enabled": true,
  "timeout": 5000
}
```

**Remote**（URL 连接）：

```jsonc
{
  "type": "remote",
  "url": "https://api.mcp.example.com/sse",
  "headers": { "Authorization": "Bearer {env:MCP_TOKEN}" },
  "enabled": true,
  "timeout": 5000
}
```

## 数据库

- PostgreSQL（通过 `DATABASE_URL` 环境变量连接，默认 `postgres://rcs:rcs@localhost:5432/rcs`）
- ORM：Drizzle ORM（`drizzle-orm/postgres-js` 驱动）
- Schema：`src/db/schema.ts`（**唯一的表结构定义来源**）
- 表：
  - better-auth 核心表：`user`、`session`、`account`、`verification`
  - better-auth organization 插件：`organization`、`member`、`invitation`
  - better-auth api-key 插件：`apikey`
  - 自定义：`mcpTool`（MCP Tool 缓存）、`scheduledTask`（定时任务）、`taskExecutionLog`（执行日志）、`shareLink`（分享链接）、`shareEventSnapshot`（分享事件快照）、`environment`（环境持久化）
  - 配置表（F002）：`provider`、`model`、`agentConfig`、`mcpServer`、`skill`、`userConfig`
  - IM 通道：`imChannel`、`imChannelRoute`、`channelBinding`（遗留兼容）
  - 知识库：`knowledgeBase`、`knowledgeResource`、`agentKnowledgeBinding`
  - Workflow：`workflow`（定义）、`workflowVersion`（版本管理）、`workflowRun`（运行记录）、`workflowEvent`（Event Sourcing 事件流）

### 数据库开发流程

**Schema → 生成迁移 → 推送到数据库**，严禁手写 SQL 迁移文件。

```bash
# 1. 修改 src/db/schema.ts（添加/修改列、索引、约束等）
# 2. 生成迁移文件（比较最新快照与当前 schema 的差异）
bunx drizzle-kit generate --name <描述性名称>

# 3. 推送到数据库（直接同步 schema 到 DB，开发环境推荐）
bunx drizzle-kit push

# 或用迁移文件逐步应用（生产环境推荐）
bunx drizzle-kit migrate
```

**关键规则**：

1. **`src/db/schema.ts` 是唯一的真相来源** — 所有表结构、索引、约束都在这里定义。永远不要手动编写或编辑 `drizzle/*.sql` 文件
2. **禁止手写 SQL 迁移** — 所有 DDL 变更必须通过 `drizzle-kit generate` 生成。手写 SQL 会导致快照不一致，后续 `generate` 会出错（需要 TTY 交互解决列冲突）
3. **`drizzle-kit push` vs `drizzle-kit migrate`**：
   - `push`：直接推送 schema 到 DB，适合开发环境快速迭代。会产生数据丢失警告（需要交互确认）
   - `migrate`：按 `drizzle/` 目录中的 SQL 文件顺序执行，适合生产环境。新项目需要先 `push` 建基线再用 `migrate`
4. **添加 organization_id 列时的注意事项**：
   - 新列设为 `NOT NULL` 时，需要先 `ADD COLUMN ... DEFAULT <值>` 回填现有数据，再 `ALTER COLUMN SET NOT NULL`
   - 或先删除 NULL 行再 push
5. **索引命名规范**：organization-scoped 唯一索引统一用 `idx_<表名>_org_<字段>` 格式（如 `idx_provider_org_name`）
6. **`drizzle-kit generate` 可能需要 TTY 交互**（处理列冲突）。在非 TTY 环境中用 `expect` 驱动：
   ```bash
   expect -c 'spawn bunx drizzle-kit generate --name xxx; expect "organization_id" { send "\r" }; expect eof'
   ```

## 测试策略

### 当前状态

后端测试全部通过（0 fail, 0 error），分布在 130+ 个文件中。已清理所有在批量运行时因 mock 污染或 DB 连接问题而失败的测试文件。具体数量请以 `bun test src/__tests__/` 实际运行为准。

### 运行命令

```bash
# 后端全部测试
bun test src/__tests__/

# 后端单个测试文件
bun test src/__tests__/store.test.ts

# 前端全部测试（从项目根目录运行）
bun test web/src/__tests__/

# 前端单个测试文件
bun test web/src/__tests__/config-mcp-page.test.ts
```

### tsconfig

后端 `tsconfig.json` extends `tsconfig.base.json`（定义 workspace 包路径别名 `@mothership/plugin-sdk`、`@mothership/core` 等）：
- `target: ES2022`、`module: ES2022`、`moduleResolution: bundler`
- `types: ["bun"]`（依赖 `@types/bun`，已安装在 devDependencies）
- 前端有独立的 `web/tsconfig.json`（`jsx: "react-jsx"`，路径别名 `@/*` → `./*`）

### 后端测试 (Bun test)

- 路径：`src/__tests__/*.test.ts`
- 模式：单元测试为主，临时文件/目录用于 config 测试
- Mock：使用 `mock.module()` 模拟依赖，需在 `import` 语句之前注册
- 注释规范：每个 `test(...)` 上方补一行中文注释，和 test label 基本匹配即可；如果测试较复杂，可补充少量说明

#### Mock 注意事项

1. **mock.module 必须在 import 之前调用**：Bun test 要求 mock 在模块加载前注册
2. **mock 隔离限制**：`mock.module()` 在同一进程中全局生效。当多个测试文件 mock 同一模块（如 `../config`）时，后加载的测试可能继承前一个测试的 mock 缓存，导致导入失败。表现为 `SyntaxError: Export named 'xxx' not found`
3. **db/better-auth mock**：测试中若需要 mock 中间件链，必须同时 mock `../db`、`../auth/better-auth`，否则动态导入会失败。注意 `plugins/auth.ts` 会间接依赖这些模块。mock `better-auth` 时需包含 `auth.api.createApiKey` 等 API 方法（如果被测代码用到了）
4. **store 函数无 mock**：`src/store.ts` 是纯内存 Map，测试直接调用 `storeReset()` 清理状态
5. **集成测试已清理**：直接连接数据库的集成测试（`ensureOrg`/`ensureUser` 模式）在批量运行时会因 mock 污染导致 `db.select().from(...).limit()` 丢失。如需新增此类测试，应使用 mock 替代真实 DB 连接，或确保在 `beforeAll` 中建立独立连接

### 前端测试 (Bun test)

- 路径：`web/src/__tests__/*.ts` 和 `*.test.tsx`
- 运行框架：Bun test（不是 vitest，尽管 `bun test` 兼容 vitest API）
- 组件测试：使用 React Testing Library + ReactDOMServer
- **文件读取路径**：使用 `import.meta.dirname` 或 `join(import.meta.dirname, "..")` 构建 web 根目录，不使用相对路径字符串（如 `"src/App.tsx"`），因为 CWD 可能不是 `web/`
- **shadcn 组件导入**：使用相对路径如 `../../components/ui/skeleton`（从 `__tests__/` 出发）
- 注释规范：每个 test(...) 上方补一行中文注释，和 test label 基本匹配即可；如果测试逻辑较复杂或存在隐藏前提，可补充说明

## 状态字段映射

两套 StatusBadge 组件，注意区分：

1. **`web/src/components/Navbar.tsx`**（会话/环境状态）
   - `active` → 活跃, `running` → 运行中, `idle` → 空闲
   - `inactive` → 离线, `requires_action` → 待操作
   - `archived` → 已归档, `error` → 错误, `disconnected` → 已断开

2. **`web/components/config/StatusBadge.tsx`**（配置页状态）
   - `configured` → 已配置, `enabled` → 已启用
   - `unconfigured` → 未配置, `disabled` → 已禁用
   - `builtIn` → 内置, `custom` → 自定义
   - `primary` → 主模型, `subagent` → 子Agent, `all` → 全部

## 权限配置

Permission 选项（`web/src/components/PermissionTab.tsx`）：

- `ask` → 询问
- `allow` → 允许
- `deny` → 拒绝

## 常见陷阱

1. **前端修改未生效**：后端直接挂载 `web/dist/`，修改前端代码后必须 `bun run build:web` 重新构建
2. **前端构建后路径错误**：Vite base 设为 `/ctrl/`，部署时需确保反向Agent匹配
3. **配置写入竞争**：`config-pg.ts` 依赖 PG 事务隔离，但未做分布式锁。并发 upsert 同一 provider 可能产生竞态
4. **WebSocket 断连**：反向Agent timeout 需 > 30s（Bun idleTimeout 默认）
5. **状态 Badge 混淆**：两个不同文件中的 StatusBadge，状态值不同
6. **工作目录漂移**：Bash `cd web` 后，相对路径命令会失败
7. **acp-link 实例 spawn 认证**：acp-link 本地 WS 始终启用 auth（`authEnabled: true`），会自动生成 64 位 hex token，不受 `--group`、`ACP_RCS_TOKEN`、`--no-auth` 参数控制。relay 连接时必须从 acp-link stdout 中用正则 `Token:\s*([a-f0-9]{64})` 捕获实际 token，通过 `?token=` 传递。不能假设环境 secret 能复用为本地 WS 认证 token
8. **acp-link 实例端口残留**：服务器重启时不会自动杀掉已 spawn 的 acp-link 子进程。若旧进程仍占用端口（如 8888），新实例 spawn 会因 `EADDRINUSE` 失败，导致 relay 找不到 running instance（报 "Agent not found or offline"）。重启服务器前应先清理残留的 acp-link 进程（`restart-server.sh` 脚本已包含清理逻辑）
9. **acp-link standalone 模式**：spawn 时不设 `ACP_RCS_URL`，acp-link 只做本地代理不连 RCS upstream。opencode 子进程由本地 WS 连接触发启动（即 relay 连接时才启动 agent）
10. **relay 断连不杀进程**：前端断连（刷新、关闭 dashboard）不应终止 acp-link 子进程，只在用户显式点击删除时才关闭。前端断连只关闭 WebSocket 连接
11. **keep_alive 不透传前端**：relay 层拦截 `keep_alive` 消息，不转发给前端，否则前端报 "Unknown message type: keep_alive"
12. **文件 API 路径**：文件系统路由已改为 `/web/sessions/:id/user/*`（不是 `/files/*`），前端 API client 同步使用 `/user` 路径
13. **API 响应兼容**：改造 API 响应格式时，必须保留旧字段（如 `instance_status`、`instance_id`）直到前端所有引用处都已迁移，否则 `isOnline` 等检查会失效
14. **多实例 relay 路由**：`agentLocalWsMap` 按 instanceId 做 key，不是 agentId。relay URL 须携带 `?sessionId=` 参数才能路由到正确实例，否则所有实例消息混入同一信道
15. **Split Button 可见性**：多实例下拉按钮应在环境在线时就显示（而非仅在多实例时），用户需要随时能"新建实例"
16. **ACP vs RCS session ID**：ACP agent 返回 `ses_xxx` 格式 session ID，RCS 内部用 `session_xxx`/`cse_xxx`。文件 API、FilePickerDialog 等需要 workspace 的操作必须用 RCS session ID（通过 `resolveExistingSessionId` 转换）。前端 `ChatInterface` 的 `activeSessionId` 是 ACP session ID，不能直接用于文件 API；需通过 `rcsSessionId` prop 从 `ACPSessionDetail` → `ACPMain` → `ChatInterface` 透传
17. **resolveWorkspacePath 不做 fallback**：当 session 找不到时不能 fallback 到用户第一个 environment（几乎总是 `/tmp`），应直接返回 404。session ID 必须通过 `resolveExistingSessionId`（session↔cse 格式转换）查找
18. **ChatInterface 有两处 ChatInput**：消息列表区域的 ChatInput 和底部发送栏的 ChatInput 是两个独立组件实例，修改 sessionId 传递时必须两处都改
19. **FilePickerDialog 上传始终到 user/**：不管当前浏览哪个目录，上传操作应始终写入 workspace 的 `user/` 子目录
20. **Workflow 节点 inputs 引用**：节点的 inputs 字段中引用的变量名必须在 `depends_on` 中声明依赖的节点中存在，否则校验失败
21. **requireOrgScope 校验链路**：资源归属校验通过 `session→environment→organization` 链路，新增路由操作 organization 级资源时必须调用 `requireOrgScope`，不能仅依赖 `sessionAuth`
22. **@noble/ciphers 替代 crypto.subtle**：HTTP 环境（非 Bun 运行时）下 `crypto.subtle` 不可用，加密操作（登录密码 AES-256-GCM）使用 `@noble/ciphers` 实现
23. **routeTree.gen.ts 严禁手动编辑**：由 `@tanstack/router-plugin` Vite 插件自动生成。新增/删除路由文件后插件会自动更新，手动编辑会被覆盖
24. **TanStack Router Vite 插件顺序**：`TanStackRouterVite` 必须在 `plugins` 数组第一位（在 `react()` 之前），否则路由树生成不正确
25. **createFileRoute 路径自动修正**：路由文件中的 `createFileRoute("...")` 路径参数会被插件自动修正为正确的路由 ID（如 `/_app/workflow_/$`），不需要手动对齐
26. **Sidebar 导航项必须有 `to` 字段**：`NAV_GROUPS` 中有 `to` 的项目渲染为 `<Link>`，没有 `to` 的渲染为 `<button>`（如"会话"仅用于高亮指示）
27. **AgentAppShell 路由参数**：`agentId` 和 `sessionId` 从路由参数注入（非 prop drilling），路由文件在 `routes/agent/` 下，`_` 后缀表示 flat route

## 代码风格

### Biome（lint + format）

项目使用 Biome v2.4.15 统一处理代码质量（lint + format），不使用 ESLint/Prettier。配置文件：`biome.json`

- **格式化**：space indent（2 空格），lineWidth 120
- **Lint 规则**：启用 `recommended` 规则集，额外配置：
  - `noExplicitAny: warn`（业务代码应避免，测试文件可接受）
  - `noNonNullAssertion: off`
  - `useConst: error`
- **测试文件覆盖**：`__tests__/` 目录下宽松处理 `noExplicitAny` 和 `noUnusedVariables`
- **命令**：`bun run lint`（检查）、`bun run format`（自动格式化）
- **VS Code 集成**：推荐安装 Biome 扩展，保存时自动格式化

### 注释约定

- 对外暴露的接口、类型、类和公共方法应补充简洁注释，优先回答“这是什么”和“拿来做什么”
- 字段名不足以表达语义时，补字段级注释；重点解释：
  - 该字段代表的平台语义或业务含义
  - 为什么它和其他相近字段需要并存，例如平台 ID 与 provider 原生 ID
  - Core 只存储不解释的扩展字段，如 metadata、provider 私有引用
- 注释保持短小直接，不把类型定义写成长文档；避免重复代码字面含义
- 仓储接口方法至少说明读取/写入对象、查询维度和异常或缺失时的行为
- runtime / registry / resolver 这类编排组件的方法，优先说明输入输出语义和失败条件
- 测试辅助实现（如 in-memory repository）的方法，至少说明它模拟的正式契约以及 `reset()` 等方法的用途
- ID 工厂、brand 类型、provider session 映射这类容易混淆的基础类型，应明确说明“平台侧”和“provider 侧”的边界

### TypeScript 类型规范

- **禁止 `as any`**：业务代码中不得使用 `as any` 绕过类型检查。新增代码如果需要类型断言，必须使用具体类型（`as { field: string }`）或 `as unknown as TargetType` 双重断言
- **Config 响应解包**：config 路由返回 `{ success: true, data: T }` 结构，前端使用 `unwrapConfigData<T>()`（`web/src/api/config-response.ts`）解包，禁止用 `(data as any)?.data ?? data`
- **Config body 类型**：config 路由的 body 字段必须注册在 `src/schemas/config.schema.ts` 的 `ConfigBodySchema` 中，Eden Treaty 才能推断正确类型。新增 config 字段时先扩展 schema，不要用 `as any` 绕过
- **Eden Treaty 路径命名**：Eden Treaty 将连字符路由路径转为 camelCase（`/web/knowledge-bases` → `client.web.knowledgeBases`），前端调用时使用 camelCase
- **API 响应数组守卫**：对 API 返回值调用 `.filter()`、`.map()` 等数组方法前，必须用 `Array.isArray()` 守卫，防止运行时 `TypeError: x.filter is not a function`
- **catch 块必须有 `console.error()`**：所有 `catch` 块中必须调用 `console.error(err)` 记录错误，便于浏览器 DevTools 调试
- **允许的例外**：
  - 测试文件（`__tests__/`）中的 `as any` 可接受
  - `zodResolver(formConfig.schema as any)` — shadcn/react-hook-form 集成的已知限制
  - 后端路由处理器中的 `(body as any) ?? {}` — Elysia 未注册 body schema 时的临时方案，优先注册 schema 消除

### 前端约束

- **禁止外部字体链接**：不使用 CDN / Google Fonts / jsdelivr 等外部字体资源，统一使用系统原生字体栈（`system-ui`, `-apple-system`, `ui-monospace` 等），保留中文 fallback

### 命名约定

| 类型 | 风格 | 示例 |
|------|------|------|
| 文件名 | kebab-case | `config-service.test.ts`, `acp-ws-handler.ts`, `StatusBadge.tsx` |
| 组件名 | PascalCase | `DataTable`, `FormDialog`, `PermissionTab` |
| 函数名 | camelCase | `storeGetEnvironment`, `handleAcpWsOpen`, `apiFetchSessions` |
| 常量 | UPPER_SNAKE_CASE | `MAX_WS_MESSAGE_SIZE`, `CONFIG_PATH` |
| 接口/类型 | PascalCase | `EnvironmentRecord`, `SessionEvent`, `AgentInfo` |
| 状态变量 | camelCase + form 前缀 | `formName`, `formModel`, `formSaving` |

### 目录结构约定

- **后端**：
  - `src/routes/`：按 API 版本或功能分组（`v1/`, `v2/`, `web/`, `acp/`, `mcp/`）
    - 新增路由：`web/workflow-defs.ts`（工作流定义 CRUD + 版本管理）、`web/workflow-engine.ts`（引擎运行控制）、`web/workflow-proxy.ts`（工作流代理）、`web/meta-agent.ts`（元智能体）
  - `src/services/`：业务逻辑层（`environment.ts`、`session.ts`、`instance.ts`、`task.ts`、`scheduler.ts`、`org-context.ts`、`knowledge-base.ts` 等）
  - `src/services/config/`：配置 CRUD 子模块（`provider.ts`、`agent-config.ts`、`mcp-server.ts`、`model.ts`、`skill.ts`、`user-config.ts`、`aggregate.ts`），桶文件 `config-pg.ts`
  - `src/repositories/`：数据访问层（`environment.ts`、`session.ts`、`task.ts`、`knowledge-base.ts` 等），接口 + 实现
  - `src/plugins/`：Elysia 插件（`auth.ts`、`cors.ts`、`error-handler.ts`、`logger.ts`、`rate-limit.ts`、`static.ts`）
  - `src/transport/`：WebSocket/传输层（`acp-ws-handler.ts`, `acp-relay-handler.ts`, `event-bus.ts`）
  - `src/auth/`：认证相关（`better-auth.ts`, `jwt.ts`, `token.ts`）
  - `src/db/`：Drizzle ORM schema（`schema.ts`）+ 连接（`index.ts`）
  - `src/__tests__/`：测试文件与源码同名，加 `.test.ts` 后缀

- **前端**：
  - `web/src/routes/`：TanStack Router 路由文件（file-based routing，`routeTree.gen.ts` 自动生成）
  - `web/src/components/`：通用组件
    - `config/`：配置页专用组件（`DataTable`, `FormDialog`）
    - `shell/`：应用外壳（`AppShell`, `Sidebar`, `Topbar`）
    - `ui/`：shadcn 原子组件
  - `web/src/pages/`：页面组件（`Dashboard.tsx`, `ModelsPage.tsx` 等，不接收导航回调）
  - `web/src/api/`：API 客户端（`client.ts`）
  - `web/src/acp/`：ACP 协议客户端（`client.ts`, `types.ts`）
  - `web/src/__tests__/`：测试文件

### 代码组织模式

1. **功能驱动提交**：一个 git commit 包含完整的端到端功能（后端服务 + API 路由 + 前端页面 + 测试）
2. **配套测试**：每个功能提交都包含对应的单元测试和集成测试
3. **验收清单**：使用 `spec/spec-human-verify.md` 进行人工验收，完成后归档

### Git 提交风格

```
<type>: <简洁的中文标题>

<详细变更列表，每行以 - 开头>

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

**类型前缀**：

- `feat:` - 新功能
- `fix:` - 修复 bug
- `refactor:` - 重构（不改变功能）
- `test:` - 测试相关

**示例**：

```
feat: 实现 Permission 配置增强（tools→permission 转换 + PermissionTab UI）
- Skills 目录从 ~/.config/opencode/skills/ 迁移到 ~/.agents/skills/
- Agent tools 布尔值自动转换为 permission 三态（allow/deny/ask）
- 新增 PermissionTab 组件：开关型工具三态 Select、规则型工具通配符规则编辑器
- 修复 PermissionTab useEffect 循环更新导致 React error #185

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

### React 组件模式

1. **状态管理**：使用 `useState` + `useCallback`，避免依赖循环
2. **导航**：使用 TanStack Router 的 `<Link to="/path">` 或 `useNavigate()`，禁止 `window.history.pushState` 和 `window.location.href`
3. **路由参数**：`Route.useParams()` 获取动态参数，`Route.useSearch()` 获取 search params
4. **表单处理**：使用 react-hook-form + zod（`FormDialog` 已封装）
5. **异步操作**：try-catch + toast 错误提示，finally 清理 loading 状态
6. **条件渲染**：使用 `&&` 或三元运算符，避免不必要的 div 包裹
7. **新增页面**：在 `web/src/routes/_app/` 下创建路由文件，组件 lazy import，插件自动注册路由

### 前端路由文件模板

新增配置页面时，在 `web/src/routes/_app/` 下创建文件：

```typescript
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const MyPage = lazy(() => import("../../pages/MyPage").then((m) => ({ default: m.MyPage })));

export const Route = createFileRoute("/_app/my-page")({
  component: () => (
    <Suspense>
      <MyPage />
    </Suspense>
  ),
});
```

- 路由路径由文件名决定（`my-page.tsx` → `/ctrl/my-page`）
- `createFileRoute` 的路径参数必须与插件生成的路径匹配（插件会自动修正）
- `routeTree.gen.ts` 由插件自动生成，无需手动编辑

### 后端路由模式

```typescript
import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import { loadOrgContext } from "../../services/org-context";

const app = new Elysia({ name: "web-resource", prefix: "/web" })
  .use(authGuardPlugin);

// POST /web/resource（Elysia 统一用 POST + action 分发）
app.post("/resource", async ({ store, body, request }) => {
  const user = store.user!;
  const authCtx = (await loadOrgContext(user, request))!;
  // authCtx.organizationId, authCtx.userId, authCtx.role
  // ... 业务逻辑（传 authCtx 给 config service 层）
  return { success: true, data: { ... } };
}, { sessionAuth: true });

export default app;
```

### 错误处理模式

- **前端**：统一使用 `toast.error()` 显示错误信息
- **后端**：返回 `{ error: { type: "...", message: "..." } }` 格式
- **结构化日志**：`src/logger.ts` 使用 `createLogger()` 工厂模式，支持 `formatEntry()` 方法便于测试，请求级 `requestId` 跟踪（`src/plugins/logger.ts` 中注入）
- **环境变量校验**：`src/env.ts` 的 `validateEnv()` 在启动时校验，测试环境抛出 Error，生产环境 `process.exit(1)`

## 文档编写规范

RCS 使用 VitePress 构建文档，分为用户文档和开发者文档。

### 目录结构

```
docs/
├── user/                    # 用户文档（小白向）
│   ├── index.md            # 术语表 + 快速导航
│   ├── getting-started.md  # 快速开始
│   ├── configuration/      # 配置管理
│   ├── sessions/           # 会话管理
│   ├── agents/             # Agent 管理
│   ├── tasks/              # 定时任务
│   └── troubleshooting.md  # 故障排查
├── developer/              # 开发者文档
│   ├── architecture/       # 架构设计
│   ├── api/                # API 参考
│   └── contributing.md     # 贡献指南
└── .vitepress/
```

### 写作规范

#### 标题层级
- **H1**：文档标题（每页唯一）
- **H2**：主要章节（自动生成侧边栏）
- **H3**：子章节
- 禁止 H4+，保持扁平结构

#### 代码示例
严格标注格式：

````markdown
```bash
# 可执行命令，显示提示符
$ bun install

# 输出结果单独标注
Server started at http://localhost:3000
```
````

#### 语言规范
- **中文优先**：正文使用中文
- **术语保留原文**：ACP、WebSocket、Provider 等首次出现时保留英文
- **中英文混排**：中文前，英文后（如 "配置 ACP Agent"）

#### 截图占位符
```markdown
<!-- TODO: 添加截图：配置页面 - Provider 表单 -->
![配置 Provider](/images/config-provider.png)
```

#### 术语表
每类用户文档开头包含术语表：

```markdown
## 术语表

| 术语 | 说明 |
|------|------|
| ACP | Agent Control Protocol，Agent 控制协议 |
| Provider | AI 服务商（如 OpenAI、Anthropic） |
```

### 文档更新时机

- **代码变更同步更新**：功能 PR 必须包含对应文档更新
- **Breaking changes**：必须更新迁移指南
- **每周审查**：定期检查过时内容

### 开发文档命令

```bash
# 启动文档开发服务器
$ bun run docs:dev

# 构建文档
$ bun run docs:build
```

### 文档模板

- 用户文档模板：`docs/user/_template.md`
- 开发者文档模板：`docs/developer/_template.md`
