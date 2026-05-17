# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

Remote Control Server (RCS) 是一个基于 Elysia + Bun 的 AI Agent 控制面板后端（package name: `mothership`），配合 React + Vite 前端，使用 PostgreSQL + Drizzle ORM 持久化。核心功能包括：

- **ACP 协议支持**：通过 WebSocket 与 acp-link Agent通信，实现远程 Agent 控制和事件流转发
- **配置管理**：Providers/Models/Agents/Skills/MCP 的动态配置，存储于 PostgreSQL（`src/services/config/` 子模块）
- **多租户**：Team Layer 隔离，所有配置和资源以 `teamId` 为范围，通过 `AuthContext` 传递
- **会话管理**：通过 SSE 向前端推送会话事件（user/assistant/tool_use/permission_request 等），支持 ACP session/list 按 cwd 过滤
- **认证授权**：better-auth (PostgreSQL) + API Key 认证，支持用户会话和 acp-link 的 Bearer token
- **定时 HTTP 任务**：cron 调度、执行历史记录、失败重试（Drizzle ORM + node-schedule）
- **用户文件系统**：会话级文件读写上传，支持 iframe 预览（`/web/sessions/:id/user/*`）
- **Channel 层**：多频道通信支持（`/web/channels`）
- **会话分享**：share link 表已创建（readonly/writable 模式），功能开发中
- **Workspace Packages**：`packages/` 下有 acp-link、core、plugin-sdk、opencode 四个内部包，通过 Bun workspaces + tsconfig paths 管理
- **知识库**：知识库管理（`src/services/knowledge-base.ts`），通过 provider 抽象（`src/services/knowledge-provider/`）对接外部知识服务

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

### 测试

```bash
# 运行所有后端测试（Bun test）
bun test src/__tests__

# 运行特定测试文件
bun test src/__tests__/config-providers.test.ts

# 前端全部测试（从项目根目录运行）
bun test web/src/__tests__/

# 前端单个测试文件
bun test web/src/__tests__/app-i18n.test.ts
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
- 启动时初始化：skills 目录迁移（`migrateSkillsDir`）、定时任务调度器（`startScheduler`）
- 优雅关闭：清理 WebSocket 连接、instances、调度器

**认证层**：

- `src/auth/better-auth.ts`：better-auth 实例，session + email/password
- `src/auth/api-key-service.ts`：per-user API Key（PostgreSQL），用于 acp-link 认证
- `src/auth/jwt.ts`：JWT 工具（worker token 生成）
- `src/auth/token.ts`：token 辅助工具
- `src/plugins/auth.ts`：Elysia 插件，`authGuardPlugin`（macro 方式提供 `sessionAuth` 装饰器）+ `AuthContext` 类型（`teamId`/`userId`/`role`）

**配置服务**：`src/services/config/`（`config-pg.ts` 为兼容桶文件，re-export 所有函数）

- 存储：PostgreSQL 数据库，6 张配置表（provider, model, agent_config, mcp_server, skill, user_config）
- 多租户：所有 CRUD 函数以 `ctx: AuthContext`（含 `teamId`/`userId`/`role`）为首参数，WHERE 条件包含 `team_id`
- 子模块拆分：`provider.ts`、`model.ts`、`agent-config.ts`、`mcp-server.ts`、`skill.ts`、`user-config.ts`、`aggregate.ts`（批量配置聚合）
- JSONB 字段：permission、knowledge、config 等复杂结构用 JSONB 存储
- 返回值约定：delete → boolean（`.returning()` 检查长度），get → 对象 | null，list → 数组
- **其他服务**：`skill.ts`（skill-fs）、`instance.ts`、`task.ts`、`scheduler.ts`、`session.ts`、`environment.ts` 负责特定功能的 CRUD 和调度

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
- `logger.ts`：请求日志
- `static.ts`：静态文件挂载

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

- better-auth 表：`user`、`session`、`account`、`verification`
- 自定义表：`apiKey`、`mcpTool`、`scheduledTask`、`taskExecutionLog`、`shareLink`、`shareEventSnapshot`、`environment`
- 配置表（F002）：`provider`、`model`、`agentConfig`、`mcpServer`、`skill`、`userConfig`

### ACP 协议要点

acp-link 是连接 AI Agent 和 RCS 的桥梁，通过 WebSocket 进行双向通信。

#### 认证方式

acp-link 有两种认证方式（优先级从高到低）：

1. **Per-user API Key**（PostgreSQL）：`Authorization: Bearer rcs_xxx` 或 `?token=rcs_xxx`
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

### 前端架构 (React + Vite)

**构建配置**：`web/vite.config.ts`

- Tailwind CSS v4 使用 `@tailwindcss/vite` 插件（**不是** tailwind.config.js）
- base path: `/ctrl/`
- 路径别名：`@/src` → `web/src`，`@/components` → `web/components`，`@server` → `../../src`（前端引用后端类型）
- 开发代理：`/web`、`/api`、`/acp` → `http://localhost:3000`

**样式系统**：`web/src/index.css`

- Tailwind v4 with `@theme` directive
- `@plugin "@tailwindcss/typography"` 用于 prose 类
- 颜色系统：brand blue (#409EFF)，深色侧边栏 (#1a1f2e)

**组件层级**：

- `web/src/App.tsx`：路由 + better-auth session 管理
- `web/src/components/shell/`：AppShell、Sidebar（应用外壳）
- `web/src/components/config/`：DataTable、FormDialog、StatusBadge（配置页通用组件）
- `web/src/components/`：FilePickerDialog、PermissionTab、SessionDetail 等功能组件
- `web/src/pages/`：Dashboard、ModelsPage、AgentsPage、SkillsPage、McpPage、TasksPage、ChannelsPage、LoginPage、ApiKeyManager、TeamsPage、KnowledgeBasesPage、WorkflowPage、EnvironmentsPage 等
- `web/src/acp/`：ACP 客户端（`client.ts`、`relay-client.ts`、`types.ts`），处理 session/list、session/load、session/resume 等 ACP 协议

**状态管理**：

- 本地状态：useState + useCallback
- 远程数据：API client (`web/src/api/client.ts`) + fetch
- 认证状态：better-auth session（cookie-based）

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

- 用户提交明文 Key 时，服务端替换为 `{env:RCS_SECRET_<provider_name>}` 存入数据库
- 实际密文存入环境变量（`.env` 或系统环境变量）
- API 响应只返回 `keyHint`（尾 4 位），如 `***ab12`

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
  - Team 权限：`team`、`team_member`
  - better-auth：`user`、`session`、`account`、`verification`
  - 自定义：`apiKey`、`mcpTool`（MCP Tool 缓存）、`scheduledTask`（定时任务）、`taskExecutionLog`（执行日志）、`shareLink`（分享链接）、`shareEventSnapshot`（分享事件快照）、`environment`（环境持久化）
  - 配置表（F002）：`provider`、`model`、`agentConfig`、`mcpServer`、`skill`、`userConfig`
  - IM 通道：`imChannel`、`imChannelRoute`、`channelBinding`（遗留兼容）
  - 知识库：`knowledgeBase`、`knowledgeResource`、`agentKnowledgeBinding`
  - Workflow：`workflow`、`workflowRun`

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
4. **添加 team_id 列时的注意事项**：
   - 新列设为 `NOT NULL` 时，需要先 `ADD COLUMN ... DEFAULT <值>` 回填现有数据，再 `ALTER COLUMN SET NOT NULL`
   - 或先删除 NULL 行再 push
5. **索引命名规范**：team-scoped 唯一索引统一用 `idx_<表名>_team_<字段>` 格式（如 `idx_provider_team_name`）
6. **`drizzle-kit generate` 可能需要 TTY 交互**（处理列冲突）。在非 TTY 环境中用 `expect` 驱动：
   ```bash
   expect -c 'spawn bunx drizzle-kit generate --name xxx; expect "team_id" { send "\r" }; expect eof'
   ```

## 测试策略

### 运行命令

```bash
# 后端全部测试
bun test src/__tests__/

# 后端单个测试文件
bun test src/__tests__/store.test.ts

# 前端全部测试（从项目根目录运行）
bun test web/src/__tests__/

# 前端单个测试文件
bun test web/src/__tests__/app-i18n.test.ts
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
3. **db/better-auth mock**：测试中若需要 mock 中间件链，必须同时 mock `../db`、`../auth/better-auth`、`../auth/api-key-service`，否则动态导入会失败。注意 `plugins/auth.ts` 会间接依赖这些模块
4. **store 函数无 mock**：`src/store.ts` 是纯内存 Map，测试直接调用 `storeReset()` 清理状态

#### 已知测试问题

- **`middleware.test.ts` 和 `routes.test.ts`**：在 `bun test src/__tests__/` 全局运行时，因 mock 缓存污染可能无法加载 `plugins/auth.ts`（报 `Export named 'xxx' not found`）。单独运行这两个文件时正常。这是 bun test 的 mock 隔离限制，非代码 bug
- **`routes.test.ts` Web Session Routes**：32 个测试预期 UUID-based 认证（`?uuid=` query param），但当前 `/web/sessions` 路由使用 `sessionAuth`（better-auth cookie）。需要更新测试或实现新的 API 端点
- **文件路由测试**：`files-route.test.ts` 和 `file-api.test.ts` 中路由路径已从 `/files` 更新为 `/user`，需确保同步

### 前端测试 (Bun test)

- 路径：`web/src/__tests__/*.ts` 和 `*.test.tsx`
- 运行框架：Bun test（不是 vitest，尽管 `bun test` 兼容 vitest API）
- i18n 测试：检查中文文本是否存在（`app-i18n.test.ts` 等）
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

## 代码风格

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
  - `src/services/`：业务逻辑层（`environment.ts`、`session.ts`、`instance.ts`、`task.ts`、`scheduler.ts`、`team.ts`、`knowledge-base.ts` 等）
  - `src/services/config/`：配置 CRUD 子模块（`provider.ts`、`agent-config.ts`、`mcp-server.ts`、`model.ts`、`skill.ts`、`user-config.ts`、`aggregate.ts`），桶文件 `config-pg.ts`
  - `src/repositories/`：数据访问层（`environment.ts`、`session.ts`、`task.ts`、`knowledge-base.ts` 等），接口 + 实现
  - `src/plugins/`：Elysia 插件（`auth.ts`、`cors.ts`、`error-handler.ts`、`logger.ts`、`static.ts`）
  - `src/transport/`：WebSocket/传输层（`acp-ws-handler.ts`, `acp-relay-handler.ts`, `event-bus.ts`）
  - `src/auth/`：认证相关（`better-auth.ts`, `api-key-service.ts`, `jwt.ts`, `token.ts`）
  - `src/db/`：Drizzle ORM schema（`schema.ts`）+ 连接（`index.ts`）
  - `src/__tests__/`：测试文件与源码同名，加 `.test.ts` 后缀

- **前端**：
  - `web/src/components/`：通用组件
    - `config/`：配置页专用组件（`DataTable`, `FormDialog`）
    - `shell/`：应用外壳（`AppShell`, `Sidebar`）
    - `ui/`：shadcn 原子组件
  - `web/src/pages/`：页面组件（`Dashboard.tsx`, `ModelsPage.tsx`, `TasksPage.tsx`, `ChannelsPage.tsx`, `SessionDetail.tsx` 等）
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
2. **表单处理**：使用 react-hook-form + zod（`FormDialog` 已封装）
3. **异步操作**：try-catch + toast 错误提示，finally 清理 loading 状态
4. **条件渲染**：使用 `&&` 或三元运算符，避免不必要的 div 包裹

### 后端路由模式

```typescript
import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import { loadTeamContext } from "../../services/team-context";

const app = new Elysia({ name: "web-resource", prefix: "/web" })
  .use(authGuardPlugin);

// POST /web/resource（Elysia 统一用 POST + action 分发）
app.post("/resource", async ({ store, body, request }) => {
  const user = store.user!;
  const authCtx = (await loadTeamContext(user, request))!;
  // authCtx.teamId, authCtx.userId, authCtx.role
  // ... 业务逻辑（传 authCtx 给 config service 层）
  return { success: true, data: { ... } };
}, { sessionAuth: true });

export default app;
```

### 错误处理模式

- **前端**：统一使用 `toast.error()` 显示错误信息
- **后端**：返回 `{ error: { type: "...", message: "..." } }` 格式
- **日志**：使用 `src/logger.ts` 的 `log()` 和 `error()`

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
