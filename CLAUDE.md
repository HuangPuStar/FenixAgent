# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

Remote Control Server (RCS) 是一个基于 Elysia + Bun 的 AI Agent 控制面板后端（package name: `fenix`），配合 React 19 + Vite 前端，使用 PostgreSQL + Drizzle ORM 持久化。核心功能包括：

- **ACP 协议支持**：通过 WebSocket 与 acp-link Agent通信，实现远程 Agent 控制和事件流转发
- **配置管理**：Providers/Models/Agents/Skills/MCP 的动态配置，存储于 PostgreSQL（`src/services/config/` 子模块）
- **多租户**：better-auth organization 插件实现多组织隔离，所有配置和资源以 `organizationId` 为范围，通过 `AuthContext` 传递
- **会话管理**：会话事件推送，支持 ACP session/list 按 cwd 过滤
- **认证授权**：better-auth + `@better-auth/api-key` 插件，支持用户会话和 acp-link 的 Bearer token
- **定时 HTTP 任务**：cron 调度、执行历史记录、失败重试
- **知识库/工作流引擎/Meta Agent**：知识库管理、DAG 工作流引擎（`@fenix/workflow-engine`）、元智能体编排
- **IM 通道**（开发中）：多平台消息通道接入与路由绑定
- **S3 文件存储**（可选）、**Redis 缓存**（可选）、**Hermes 消息推送**（可选）
- **Workspace Packages**：`packages/` 下有 acp-link、core、plugin-sdk、plugin-opencode、sdk、workflow-engine 六个内部包

**依赖结构**：`web/` 没有独立的 `package.json`，所有前后端依赖统一在根 `package.json` 管理。前端代码在 `web/` 但依赖安装/升级都在根目录执行。

## 常用命令

```bash
bun run dev              # 后端开发（热重载）
bun run dev:web          # 前端开发（Vite dev server，独立进程）
bun run build:web        # 生产构建前端（修改前端代码后必须执行！）
bun run docs:dev         # 文档开发（VitePress）
bun run docs:build       # 构建文档
bun run precheck         # ⚠️ 提交前必须通过（格式化 + import 排序 + tsc + biome check）
bun run check:deps       # 依赖健康检查
bun run db:push          # 数据库 schema 同步（开发环境）
bun run db:generate --name <名称>  # 生成迁移文件（修改 schema.ts 后执行）
bun run db:migrate       # 应用迁移文件（生产环境）
```

### 测试

```bash
bun test src/__tests__/                       # 后端全部测试
bun test src/__tests__/store.test.ts          # 后端单个文件
bun test web/src/__tests__/                   # 前端全部测试
bun test web/src/__tests__/config-mcp-page.test.ts  # 前端单个文件
```

测试账号：`admin@test.com` / `admin123456`

### 关键注意事项

- **`bun run precheck` 是代码质量的第一标准**。流程：`biome format --write` → `biome check --write --linter-enabled=false`（import 排序）→ `tsc` → `biome check`。格式和 import 排序自动修复
- 后端挂载 `web/dist/` 提供前端静态文件，修改前端后**必须** `bun run build:web`
- **前端开发代理**：`web/vite.config.ts` 配置了 `/web`、`/api`、`/acp` 代理到 `http://localhost:3000`，`dev:web` 时前端请求自动转发到后端
- **严禁手写 SQL 迁移**：所有 schema 变更通过 `src/db/schema.ts` → `drizzle-kit generate` → `push/migrate`
- **环境变量**：新增必须先在 `src/env.ts` 的 `envSchema` 中声明（Zod `zod/v4`）
- **代码质量工具**：Biome v2.4.15 统一 lint + format（`biome.json`），不使用 ESLint/Prettier
- **Swagger API 文档**：`/docs/swagger`，新增路由时添加 `.tags()` 分组
- **工作目录漂移**：Bash `cd web` 后相对路径会出错，使用绝对路径或每次回 cd

## 架构关键点

### 后端架构 (Elysia + Bun)

**入口**：`src/index.ts` — 挂载路由和插件，启动时执行：DB 初始化 → 重置所有 `agent_session.status` 为 idle → `validateEnv()` → `applyEnv()` → `getCoreRuntime()`（注册 opencode 插件 + local node）→ `startScheduler()` → 清理残留 acp-link 进程 → auto-start 带 `autoStart=true` 的 Environment 实例 → `app.listen()`。全局请求体限制 10MB，路径双斜杠自动 302 重定向。优雅关闭：Hermes → ACP 连接 → Relay 连接 → 所有 Instance → Scheduler → Cache → PG 连接

- `/v1/*`：旧版环境/会话 API（`src/routes/v1/`）
- `/v2/*`：**主流**，Worker/CodeSession 相关 API（`src/routes/v2/`）
- `/web/*`：控制面板业务 API（`src/routes/web/`，18 个子模块：auth/config/environments/instances/sessions/files/s3-files/user-file/skills/tasks/knowledge-bases/channels/organizations/control/meta-agent/workflow-defs/workflow-engine/workflow-sse）
- `/acp/*`：ACP WebSocket 端点（`src/routes/acp/`）
- `/mcp/*`：MCP 知识库查询（`src/routes/mcp/`）
- `/workflow-ui/*`：Workflow 可视化编辑器代理到 acpx-g 服务（`src/routes/web/workflow-proxy.ts`）
- `/hooks/*`：Webhook 触发路由（无认证）

**认证层**（`src/auth/`）：better-auth + organization + apiKey 插件。`src/plugins/auth.ts` 提供 `authGuardPlugin`（`sessionAuth` macro），`src/services/org-context.ts` 的 `loadOrgContext` 从请求解析 `AuthContext`（`organizationId`/`userId`/`role`）。认证优先级：better-auth session cookie → API Key（`rcs_xxx`）→ Environment Secret → 全局 `RCS_API_KEYS`。组织 ID 从 `x-active-org-id` header > `activeOrganizationId` query param > `active_org_id` cookie 提取，结果缓存 60 秒。测试通过 `setTestAuth()` + `setTestOrgContext()` 绕过

**验证层**（`src/schemas/`）：所有路由请求体通过 Zod v4 schema 校验。新增路由必须创建对应 schema 文件（如 `session.schema.ts`），通过 `index.ts` 统一导出。v1/v2 路由各有独立 schema 文件。

**配置服务**（`src/services/config/`）：6 张配置表 CRUD，多租户隔离（`AuthContext` 首参 + `organization_id` WHERE）。返回值约定：delete → boolean，get → 对象 | null，list → 数组

**传输层**（`src/transport/`）：三层架构

- **ACP WS Handler**（`acp-ws-handler.ts`）：管理 acp-link 的 WebSocket 连接注册（`connections` Map），NDJSON 格式通信，server 端 keep_alive + 客户端活跃超时检测（3 倍 keepalive 间隔）
- **Relay 子模块**（`relay/`）：前端到 Agent 的中继桥接，两种模式：
  - **Instance 模式**（优先）：通过 `CoreRuntimeFacade.connectInstanceRelay()` 获取 handle，消息直接转发；handle 未就绪时 buffer 消息，连接后 flush
  - **EventBus 模式**（fallback）：直连 acp-link WS 时，通过 EventBus subscribe 转发 inbound 消息
  - `RelayConnectionManager`（`connection-manager.ts`）管理所有前端 relay 连接，最后一个 relay 断开时关闭 core relay handle
  - `message-router.ts`：过滤 keep_alive/connect、发布 inbound 到 EventBus（供 SSE 订阅者）、flush outbound buffer
- **EventBus**（`event-bus.ts`）：pub/sub 事件总线，per-session/per-agent 隔离。每个 bus 缓存最近 5000 条事件（超限时裁剪到一半），支持 `getEventsSince(seqNum)` 做 SSE 断线重连。`event-service.ts` 是 service 层的统一入口封装

**插件层**（`src/plugins/`）：auth、cors、error-handler（`AppError` → HTTP 状态码）、logger（requestId）、rate-limit、static、require-team-scope（`requireOrgScope` 组织资源校验）

**核心服务模块**（`src/services/`）按业务域划分：

- **环境管理**：`environment.ts`（barrel re-export）→ `environment-acp.ts`（ACP 注册/连接/心跳/能力上报）、`environment-web.ts`（前端 CRUD + 实例列表聚合）、`environment-core.ts`（workspace 验证/secret 生成/响应组装/删除）
- **实例管理**：`instance.ts` — `@fenix/core` RuntimeFacade 的 RCS 适配层。核心模式：`CoreRuntimeFacade` 管理实例生命周期（spawn/stop/list），`supplements` Map 补充 core 不维护的 RCS 业务字段（userId/environmentId/organizationId/instanceNumber）。`ensureRunning()` 做并发安全：async gap 后重新检查，避免重复 spawn
- **会话管理**：`session.ts` — 轻量存根，session 元数据由 Agent 进程管理。RCS 侧仅维护 EventBus 活跃状态 + PG 持久化
- **Core Bootstrap**：`core-bootstrap.ts` — 全局 `CoreRuntimeFacade` 单例工厂，注册 opengine plugin + local node + `onInstanceStarted` 回调。可替换的 facade 工厂（测试时注入 mock）
- **Launch Spec**：`launch-spec-builder.ts` — 将 DB 中的 Agent/Model/MCP/Skill/Knowledge 配置转换为 `AgentLaunchSpec`（SDK 格式）。MCP 配置格式转换：DB `local/remote` → SDK `stdio/streamable-http`；Model 解析 `provider/model` 斜杠引用
- **定时任务**：`scheduler.ts` — node-schedule cron 调度，并发执行保护（`runningTasks` Set 防重入），可替换的 `scheduleJobImpl`（测试时注入）
- **知识库**：`knowledge-base.ts`、`knowledge-provider/` — 知识库管理与检索
- **IM 通道**：`channel-binding.ts`、`channel-provider.ts` — 消息通道接入（开发中）
- **Meta Agent**：`meta-agent.ts` — 自举式环境管理：查找/创建 meta-agent Environment → 确保 AgentConfig + Skill 注册 → spawn 实例 + 创建 API key
- **工作流**：`workflow/` — per-organization 的 `WorkflowEngine` 实例缓存（`engines` Map），使用 PG StorageAdapter（事件溯源模式：workflowEvent + workflowSnapshot + workflowNodeOutput）和 ACP Transport（通过 EventBus 收集 agent 响应，等待 `prompt_complete` 信号）
- **配置服务**（`config/`）：`config-pg.ts` 是 barrel re-export，实现拆分到子模块。`aggregate.ts` 的 `getAgentFullConfig()` 一次加载 agent + providers + skills + mcpServers（并行查询）。`jsonb.ts` 兼容旧双重编码

**Repository 层**（`src/repositories/`）：数据访问抽象，接口 + 实现模式。新增数据表访问须创建对应 Repository 文件，接口命名 `IXxxRepo`，实现类直接导出，通过 `index.ts` 统一导出。Service 层通过注入 Repository 访问数据，禁止直接 import `db` 写查询。

**内存存储**（`src/types/store.ts`）：连接条目类型定义（`AcpConnectionEntry`/`RelayConnectionEntry` 等），运行时 Map 在各 transport handler 中维护。Agent 断开时直接删除记录（不保留 offline）

**错误类**（`src/errors.ts`）：`AppError`（基类）、`ValidationError`(400)、`NotFoundError`(404)、`ConflictError`(409)、`ConfigWriteError`(500)

**DI / 测试注入模式**：多个服务模块使用可替换的工厂函数或模块级变量实现测试注入，而非构造函数注入：
- `core-bootstrap.ts`：`setCoreRuntimeFactory(fn)` 替换 facade 工厂
- `launch-spec-builder.ts`：`setBuildLaunchSpec(fn)` 替换构建逻辑
- `scheduler.ts`：`setScheduleJobImpl(fn)` 替换 cron 调度
- `session.ts`：`_setEventService()`、`_setUuid()`、`_setSessionRepo()` 覆盖依赖
- `plugins/auth.ts`：`setTestAuth()` 绕过认证
- `services/org-context.ts`：`setTestOrgContext()` 绕过 DB 查询
- `repositories/index.ts`：`resetAllRepos()` 重置内存仓储

**Config 服务架构**：`config-pg.ts` 是 barrel re-export（所有实现已迁移到 `src/services/config/` 子目录）。新增配置 CRUD 须在 `config/` 下对应子模块实现，保持 `config-pg.ts` 的 re-export 兼容。`aggregate.ts` 的 `getAgentFullConfig()` 是 spawn 时一次性加载入口（并行查询 providers + mcpServers + skills）。`jsonb.ts` 的 `parseJsonb<T>()` 兼容旧双重编码数据

**Workflow 引擎架构**：per-organization 的 `WorkflowEngine` 实例（`engines` Map，lazy 创建）。三层适配：
- `pg-storage-adapter.ts`：事件溯源存储（workflowEvent + workflowSnapshot + workflowNodeOutput），所有查询限定 `organizationId`
- `acp-transport.ts`：通过 EventBus 收集 agent 响应，等待 `prompt_complete` 信号后拼接输出
- `createAgentConfigResolver()`：按 name 查 agentConfig 表解析步骤/模型/权限配置

### Workspace 自动计算

路径：`{WORKSPACE_ROOT ?? cwd/workspaces}/{organizationId}/{userId}/{environmentId}`

- `src/services/workspace-resolver.ts`：`resolveWorkspacePath(orgId, userId, envId)`
- workspace 路径运行时实时计算，不依赖 DB `workspacePath` 字段
- 新 environment 的 `workspacePath` 列写空字符串，旧 environment 的为历史值

### ACP 协议要点

**认证方式**（优先级从高到低）：

1. better-auth API Key：`Authorization: Bearer rcs_xxx` → `auth.api.verifyApiKey({ body: { key: token } })`
2. 全局 API Key：`RCS_API_KEYS` 环境变量

**WebSocket 端点**：

- `/acp/ws`：acp-link 注册（NDJSON 格式，消息类型：register/registered/identify/keep_alive）
- `/acp/relay/:agentId`：前端中继（cookie-based auth），`keep_alive` 和 `list_sessions` 由 relay 层拦截

**REST 注册**：POST `/v1/environments/bridge`（注册）→ WS `/acp/ws?token=xxx` → `{"type":"identify","agent_id":"env_xxx"}`

**关键约定**：

- relay 断连不杀 acp-link 进程，仅用户显式删除才终止
- `agentLocalWsMap` 按 instanceId 做 key（非 agentId），relay URL 须携带 `?sessionId=`
- 注册时若无 session 自动创建默认 session
- 超时/disconnect 直接删除内存记录（不保留 offline）

### Workspace Packages

`packages/` 下 6 个内部包（`private: true`，`tsconfig.base.json` 路径映射）：

- **acp-link**：ACP stdio-to-WebSocket 桥接器
- **@fenix/core**：核心运行时抽象（types/registry/runtime/facade）
- **@fenix/plugin-sdk**：插件开发 SDK（engine-plugin/engine-relay 接口）
- **@fenix/opencode**：opencode 引擎插件实现（目录名 `plugin-opencode`）
- **@fenix/sdk**：前端 API SDK 工厂，各业务模块 Api 类（目录名 `sdk`）
- **@fenix/workflow-engine**：DAG 工作流引擎 — parser/scheduler/executor/recovery/secrets（开发中，API 可能变化）

### 前端架构 (React 19 + Vite + TanStack Router)

**版本**：React 19 + React DOM 19，可直接使用 ref prop（不需要 `forwardRef`）。

**构建配置**（`web/vite.config.ts`）：Tailwind v4（`@tailwindcss/vite`）、TanStack Router（`@tanstack/router-plugin/vite`，**plugins 数组第一位**）、base path `/ctrl/`。

路径别名：
- `@/src` → `web/src`
- `@/components` → `web/components`
- `@server` → `../src`
- `@fenix/sdk` → `packages/sdk/src/index.ts`

Vite 代理：`/web`、`/api`、`/acp` 代理到 `http://localhost:3000`（仅 `dev:web` 模式）

手动 chunk 分割：shiki / mermaid / motion / vendor(react) / ai-sdk / qr / radix-ui / tanstack-router / tanstack / hookform

**UI 技术栈**：

- 组件基础：Radix UI（通过 shadcn/ui 包装，`web/components/ui/`）
- 组件生成：通过 shadcn CLI（`bunx shadcn add <component>`），配置见根目录 `components.json`。禁止手写 Radix 原生组件，优先用 shadcn/ui 包装
- 风格：new-york
- 图标：**lucide-react 是唯一的图标来源**，禁止内联 `<svg>` 手写图标。所有图标必须从 `lucide-react` 导入具名组件（如 `import { ChevronRight } from "lucide-react"`）。需要自定义大小/颜色时通过 `className` 和 `size` prop 控制，不要为此写内联 SVG。lucide 没有的图标应提交 PR 或用简单 CSS 代替，不要内联 SVG
- 样式：Tailwind CSS v4 + `tw-animate-css` + `tailwind-merge` + `class-variance-authority`
- Toast：sonner
- 动画：motion
- 命令面板：cmdk
- 表格：@tanstack/react-table
- 流程图/工作流可视化：@xyflow/react + dagre
- Chat 消息系统：基于 Vercel AI SDK（`ai` + `@ai-sdk/react`），消息类型使用 `UIMessage`/`UIMessageChunk`，传输层实现 `ChatTransport` 接口

**路由**（file-based routing，`web/src/routes/`）：

- `_app` 是 pathless layout（v1 控制面板），`_` 前缀不贡献 URL 段
- `_` 后缀（如 `workflow_.$`）是 flat route；`$` 前缀是动态参数
- `__root.tsx` 统一认证检查
- `routeTree.gen.ts` 由 Vite 插件自动生成，**严禁手动编辑**
- 新增页面：在 `web/src/routes/_app/` 下创建路由文件，组件 lazy import
- v2 Agent 面板：`web/src/routes/agent/_panel.tsx`（AgentPanelLayout），`$agentId.tsx` 重定向到 chat，`$agentId_.$sessionId.tsx` 带 session 路由

**前端双版本（v1 控制面板 / v2 Agent 面板）**：

| | v1 控制面板 | v2 Agent 面板 |
|---|---|---|
| **入口路由** | `web/src/routes/_app.tsx` | `web/src/routes/agent/_panel.tsx` |
| **Shell** | `web/src/components/shell/`（AppShell、Sidebar、Topbar） | `web/src/pages/agent-panel/`（AgentPanelLayout、AgentSidebar、ChatPanel、ArtifactsPanel） |
| **布局** | Sidebar（可折叠）+ Topbar + 主内容区 | AgentSidebar（不可折叠）+ ChatPanel（中间）+ ArtifactsPanel（右侧可调整宽度，localStorage 持久化） |
| **共享组件** | `web/components/`（chat/、ai-elements/、ui/） | 同左，修改影响两边 |
| **CSS** | `web/src/index.css` | 专有 `agent-panel.css` |
| **ACP 连接** | 不直接使用 | `web/src/acp/` — `ACPClient` 通过 `createRelayClient(agentId, sessionId)` 创建，WebSocket cookie 认证，`buildRelayUrl()` 自动 ws/wss 协议选择 |

注意事项：

- v2 Sidebar 不支持折叠，不要添加 collapsed 相关逻辑
- OrgSwitcher 被两个版本共用，样式需保持一致

**导航**：`<Link to="/path">` 或 `useNavigate()`，**禁止** `window.history.pushState` / `window.location.href`

**API Client**（`web/src/api/sdk.ts`）：**类架构 SDK 是规范的 API 调用方式**。前端通过 `import { envApi, sessionApi } from "@/src/api/sdk"` 使用各业务模块 API 实例（如 `AgentApi`、`SessionApi`、`EnvironmentApi` 等）。每个模块封装 fetch 调用与类型转换，`credentials: "include"` 携带 session cookie。

### 前端 i18n 国际化

react-i18next + i18next，英文默认，中英双语。

**适用范围**：所有 `web/` 下的 TSX 文件均须遵守，无例外。包括 `web/components/`、`web/src/pages/`、`web/src/components/` 下的所有组件（含 `chat/`、`ai-elements/`、`agent-panel/` 等子目录）。不遵守 i18n 的组件不应该被合入。

**命名空间**：见 `web/src/i18n/index.ts` 的 `NS` 常量。现有命名空间：common / login / sidebar / dashboard / agents / models / skills / mcp / tasks / workflows / sessions / environments / orgs / apikey / channels / knowledge / agentPanel / components。

- 语言检测：localStorage `rcs-lang` → `navigator.language`
- 翻译文件：`web/src/i18n/locales/{en,zh}/<namespace>.json`
- 命名空间选择：用 `NS` 常量（`useTranslation(NS.AGENT_PANEL)`），不要用字符串字面量（`useTranslation("agentPanel")`）
- 公共组件（`web/components/` 下被多处引用的组件）使用 `"components"` 命名空间；页面专属内容使用对应页面命名空间

**新增命名空间步骤**（仅新建页面/模块时需要）：

1. 创建 `en/<namespace>.json` 和 `zh/<namespace>.json`
2. 在 `web/src/i18n/index.ts` 中添加 import、`NS` 常量、en/zh resources 注册、ns 数组
3. 组件中 `const { t } = useTranslation(NS.<NAMESPACE>)`

**硬编码规则**：

- **禁止**在 JSX 中硬编码用户可见的英文字符串或中文字符串（按钮文字、标题、提示、placeholder、错误提示、状态标签等一律走 `t()`）
- 中文注释不受此限制
- `console.log` / `console.error` 中的调试信息不受此限制
- placeholder 默认值（如 `placeholder = "给智能体发送消息…"`）也必须走 i18n
- `title` / `aria-label` 等 HTML 属性中的文字也必须走 i18n
- toast 消息中的文字也必须走 i18n

**常见违规模式**（绝对禁止）：

```tsx
// ❌ 硬编码中文
<span>执行计划</span>
<span>{running} 运行中</span>
<span>暂无会话</span>
placeholder = "给智能体发送消息…"
title="命令列表"

// ✅ 正确做法
<span>{t("plan.title")}</span>
<span>{t("toolCall.running", { count: running })}</span>
placeholder={t("input.placeholder")}
```

**禁止**：模块级 `i18n.t()` 调用、新建 `*-i18n.test.ts`

## 配置存储

配置 API：`POST /web/config/:module`（providers/models/agents/skills/mcp），action 分发（list/get/set/create/delete/enable/disable），响应 `{ success, data }` 或 `{ success, error: { code, message } }`。

### API Key 安全策略

- `@better-auth/api-key` 插件管理，SHA-256 hash 存储，创建时返回明文（仅一次）
- 验证：`auth.api.verifyApiKey({ body: { key: token } })`
- Provider API Key 用 `{env:RCS_SECRET_<name>}` 占位符，密文存环境变量

### better-auth 服务端 API 调用约定

所有参数通过**单参数对象**传递，POST 端点业务数据嵌套在 `body` 中：

```typescript
await auth.api.createOrganization({
  body: { name: "Personal", slug: "personal-xxx" },
  headers: request.headers,
});
```

- `expiresIn` 单位是**天**，`null` 表示永不过期
- `listMembers` 返回 `{ members, total }`，需用 `res.members`
- 所有需要 session 的 API 必须传 `headers: request.headers`

### Skills 存储路径

元数据在 PostgreSQL `skill` 表，Markdown 内容在文件系统 `{SKILL_DIR}/<name>/SKILL.md`（`SKILL_DIR` 环境变量，默认 `./data/skills`）

### Permission 权限系统

`permission` 三态：`"ask"` 询问、`"allow"` 允许、`"deny"` 拒绝。规则型工具（read/edit/bash 等）支持通配符规则，开关型工具（todowrite/question/webfetch 等）仅三态。

内置 Agent（不可删除）：`build`、`plan`、`general`、`explore`、`title`、`summary`、`compaction`

## 数据库

PostgreSQL + Drizzle ORM（`drizzle-orm/postgres-js`），Schema 在 `src/db/schema.ts`（唯一真相来源）。

表分类：better-auth 核心表（user/session/account/verification）、organization 插件（organization/member/invitation）、api-key 插件（apikey）、自定义表（mcpTool/scheduledTask/taskExecutionLog/shareLink/shareEventSnapshot/environment）、配置表（provider/model/agentConfig/mcpServer/skill/userConfig）、知识库（knowledgeBase/knowledgeResource/agentKnowledgeBinding）、Workflow（workflow/workflowVersion/workflowRun/workflowEvent/workflowSnapshot/workflowNodeOutput）、IM 通道（imChannel/imChannelRoute/channelBinding）

### Schema 变更流程

1. 修改 `src/db/schema.ts`
2. `bunx drizzle-kit generate --name <描述>` — 生成迁移 SQL 到 `drizzle/` 目录
3. `bun run db:push` — 开发环境验证（直接同步 schema 到数据库，无追踪记录）
4. 确认无误后提交 `drizzle/` 目录下的迁移文件

### 生产迁移

- **迁移入口**：`scripts/migrate.ts`（使用 `drizzle-orm/postgres-js/migrator` 直接执行，不依赖 `drizzle-kit` CLI）
- **Docker 构建**：`bun build scripts/migrate.ts --target=bun` 打包为独立 `migrate.js`，生产镜像包含 `migrate.js` + `drizzle/` 目录
- **执行方式**：`bun migrate.js`，生产环境首选；`docker-compose.prod.yml` 的 `rcs-migrate` 服务自动执行
- **幂等性**：已执行的迁移自动跳过（通过 `drizzle.__drizzle_migrations` 追踪表）

### 迁移追踪机制

- 追踪表：`drizzle` schema 下的 `__drizzle_migrations`（注意不是 `public` schema）
- 匹配依据：迁移 SQL 文件内容的 SHA-256 哈希值（非 tag 名）
- `db:push` 不写追踪记录，`migrate` 会写入

### 数据库开发铁律

- **禁止手写 SQL 迁移**，会导致快照不一致
- **禁止在生产环境使用 `db:push`**，必须通过 `migrate.js` 执行迁移
- **禁止在生产数据库上运行 `drizzle-kit push`**
- **新增迁移文件后必须提交 `drizzle/` 整个目录**（含 `meta/_journal.json`、`meta/*_snapshot.json`、`*.sql`）
- 索引命名：`idx_<表名>_org_<字段>` 格式
- `drizzle-kit generate` 可能需要 TTY 交互，非 TTY 用 `expect` 驱动

### 从 db:push 切换到 migrate

如果现有数据库是用 `db:push` 创建的，需要手动补追踪记录才能切换到 `migrate` 模式：

```sql
-- 1. 获取迁移 SQL 文件的 SHA-256 哈希
-- 在项目目录执行：bun -e "import crypto from 'node:crypto'; import fs from 'node:fs'; const sql = fs.readFileSync('./drizzle/0000_xxx.sql').toString(); console.log(crypto.createHash('sha256').update(sql).digest('hex'))"

-- 2. 插入追踪记录（注意 schema 是 drizzle，不是 public）
INSERT INTO drizzle."__drizzle_migrations" (hash, created_at)
VALUES ('<sha256哈希值>', <journal中的when时间戳>);
```

## 测试策略

### 后端测试 (Bun test)

路径 `src/__tests__/*.test.ts`。Mock 通过 `src/test-utils/setup-mocks.ts` 集中注册（`bunfig.toml` preload），测试文件通过 stub API 配置行为。

#### Mock 白名单

以下模块允许被 mock（在 `setup-mocks.ts` 中集中注册）：

- `../db` — 数据库连接
- `../services/config-pg` — 数据库 CRUD 操作
- `../auth/better-auth` — 认证服务
- `../auth/api-key-service` — API Key 服务

**禁止在测试文件中调用 `mock.module()`。** 测试文件通过 `stubXxx()` 函数配置行为。

#### 测试分层

| 层级 | 对象 | Mock | 命名 |
|------|------|------|------|
| L1 | 纯函数/工具函数 | 无 | `<功能>.test.ts` |
| L2 | 业务逻辑 | `stubConfigPg` / `stubAuthApi` | `<模块>-<功能>.test.ts` |
| L3 | 路由集成 | stub + `setTestAuth` + `setTestOrgContext` | `route-<路由>.test.ts` |
| 前端 | 关键用户流程 | mock fetch / MSW | `<功能>-flow.test.ts` |

#### Stub 使用规范

```ts
import { resetAllStubs, stubConfigPg } from "../test-utils/helpers";

beforeEach(() => {
  resetAllStubs();        // 必须先 reset
  stubConfigPg({ ... });  // 再配置需要的 stub
});
```

- `beforeEach` 重置，不用 `afterEach`
- 未配置的 stub 访问时抛出明确错误
- 新增 mock 白名单模块：1) 在 `src/test-utils/stubs/` 新建 stub 文件；2) 在 `setup-mocks.ts` 注册；3) 更新本白名单

#### 测试编写规则

- 每个测试独立，不依赖执行顺序
- 每个 test 上方一行中文注释
- L3 路由测试不重复 L2 的逻辑细节
- 前端只测关键流程，不写类型检查测试

#### Mock 注意事项

1. ~~`mock.module()` 必须在 import 之前调用~~ — 已废弃，统一使用 `setup-mocks.ts` + stub API
2. 禁止直接连接数据库的集成测试，用 stub 替代
3. 禁止在测试文件中调用 `mock.module()`，统一使用 `src/test-utils/` 下的 stub 注册表
4. `bunfig.toml` 的 preload 确保所有测试在执行前加载 mock 注册

### 前端测试 (Bun test)

路径 `web/src/__tests__/`，React Testing Library + ReactDOMServer。文件路径用 `import.meta.dirname` 构建（不用相对路径字符串）。

注释规范：每个 `test(...)` 上方补一行中文注释。

**前端测试规则**：只测关键流程（表单提交、数据操作、导航路由、状态联动），不写类型检查测试和纯 UI 结构断言。Mock API 使用 `fetch` mock 或 MSW，不用 `mock.module()`。命名 `<功能>-flow.test.ts`。

### tsconfig

后端 extends `tsconfig.base.json`（workspace 路径别名），前端独立 `web/tsconfig.json`（`jsx: "react-jsx"`，`@/*` → `./*`）。

## 状态字段映射

两套 StatusBadge，状态值不同：

- `web/src/components/Navbar.tsx`：会话/环境状态（active/running/idle/inactive 等）
- `web/components/config/StatusBadge.tsx`：配置页状态（configured/enabled/unconfigured/disabled 等）

## 常见陷阱

### 架构约束

违反会直接导致 bug，写代码前必须了解：

1. **配置写入竞争**：`config-pg.ts` 无分布式锁，并发 upsert 可能竞态
2. **acp-link spawn 认证**：本地 WS 始终 auth，自动生成 64 位 hex token。relay 连接时须从 stdout 用正则 `Token:\s*([a-f0-9]{64})` 捕获，不能假设环境 secret 复用
3. **acp-link 端口残留**：服务器重启不会杀旧进程，`EADDRINUSE` 导致 spawn 失败，需先清理
4. **acp-link standalone 模式**：spawn 时不设 `ACP_RCS_URL`，opencode 子进程由 relay 连接触发启动
5. **relay 断连不杀进程**：前端断连只关 WS，不终止 acp-link 进程
6. **keep_alive 不透传前端**：relay 层拦截，否则前端报 "Unknown message type: keep_alive"
7. **ACP vs RCS session ID**：ACP 返回 `ses_xxx`，RCS 用 `session_xxx`/`cse_xxx`。文件 API 须用 RCS ID（`resolveExistingSessionId` 转换）
8. **requireOrgScope 校验链路**：新增 organization 级资源路由必须调用 `requireOrgScope`
9. **@noble/ciphers 替代 crypto.subtle**：HTTP 环境下加密用 `@noble/ciphers`
10. **`workspacePath` 废弃，实时计算**：`rowToRecord` 已统一用 `resolveWorkspacePath(orgId, userId, envId)` 计算 `workspacePath` 和 `directory`，DB 的 `workspace_path` 列不再被读取。禁止在其他地方直接用 `row.workspacePath`（DB 原始值）做路径操作，一律通过 `EnvironmentRecord.workspacePath`（已计算）使用
11. **`||` vs `??` 陷阱**：`repo.create` 的默认值必须用 `??` 不用 `||`。空字符串 `""` 是 falsy 但不是 nullish，`"" || fallback` 会跳过空字符串直接走 fallback，`"" ?? fallback` 则保留空字符串。任何新参数如果允许空字符串作为合法值，必须用 `??`
12. **改动涉及字段废弃时必须全局搜索所有读取点**：废弃一个 DB 字段（如 `workspacePath`）时，必须 `grep` 全部 `.workspacePath` / `.directory` 的读取点，逐一确认已迁移到新逻辑。不能只改写入端不改读取端——写入空字符串后，所有未迁移的读取点会拿到空值导致路径错误
13. **workspace 路径由 plugin 根据 ID 自行计算，RCS 服务端不传绝对路径**：`opencode-runtime.ts` 的 `resolveWorkspace` 用 `organizationId + userId + environmentId` 拼 `cwd`。RCS 服务端只需确保 `environmentId` 通过 `AgentLaunchSpec` 正确传递（`instance.ts → buildLaunchSpec → launchInstance → plugin.prepareEnvironment`），不传 `workspace` 绝对路径——服务端和 plugin 的文件系统可能不同
14. **relay 层必须转发 agent 的 `status` 消息（含 capabilities）**：`relay-handler.ts` 的 `onMessage` 回调不能丢弃 agent 发来的 `status` 消息。该消息携带 `capabilities`（含 `sessionCapabilities.list`），前端依赖它来判断是否支持 `session/list`/`session/load` 等 ACP 能力。丢弃会导致 `ACPState.supportsSessionList` 始终为 `false`，前端永远不发送 `session/list`，chat history 无法加载。正确做法：先发 relay 自身的 `status`（带 `agent_prompt`），再注册 `onMessage` 并转发 agent 的 `status`（带 `capabilities`），确保前端依次收到连接就绪信号和能力信息

### API/路由约定

涉及端点时必须遵守：

1. **文件 API 路径**：`/web/sessions/:id/user/*`（不是 `/files/*`）
2. **API 响应兼容**：改造格式时保留旧字段直到前端全部迁移
3. **多实例 relay 路由**：`agentLocalWsMap` 按 instanceId 做 key，relay URL 须 `?sessionId=`
4. **resolveWorkspacePath 不做 fallback**：session 找不到时返回 404，不 fallback 到第一个 environment
5. **Workflow 节点 inputs 引用**：引用的变量必须在 `depends_on` 依赖的节点中存在

### 前端实现细节

改对应模块时参考：

1. **前端修改未生效**：后端挂载 `web/dist/`，修改后必须 `bun run build:web`
2. **WebSocket 断连**：反向Agent timeout 需 > 30s（Bun idleTimeout 默认）
3. **状态 Badge 混淆**：两个不同文件的 StatusBadge，状态值不同
4. **Split Button 可见性**：多实例下拉按钮应在环境在线时就显示
5. **ChatInterface 有两处 ChatInput**：修改 sessionId 传递时必须两处都改
6. **FilePickerDialog 上传始终到 user/**：不管浏览哪个目录
7. **routeTree.gen.ts 严禁手动编辑**：由 Vite 插件自动生成
8. **TanStack Router Vite 插件顺序**：`TanStackRouterVite` 必须在 `plugins` 数组第一位
9. **createFileRoute 路径自动修正**：插件会自动修正路由 ID，不需要手动对齐
10. **Sidebar 导航项必须有 `to` 字段**：有 `to` 渲染 `<Link>`，没有则渲染 `<button>`
11. **AgentPanelLayout 路由参数**：`agentId`/`sessionId` 从路由参数注入，v2 路由在 `routes/agent/_panel/` 下

## 代码风格

### Biome（lint + format）

Biome v2.4.15，space indent 2，lineWidth 120。`noExplicitAny: warn`，`noNonNullAssertion: off`，`useConst: error`。测试目录宽松处理。

#### biome-ignore 使用规范

- **禁止对 biome-ignore 行做 `--write` 自动修复**：会误删 suppression 注释，连带破坏类型断言
- **precheck 的 `--write` 只用于格式化和 import 排序**（`--linter-enabled=false`）
- biome 报 `suppressions/unused` warning 时，确认代码仍需该 suppression 后保留

### TypeScript 类型规范

- **Zod v4**：项目使用 Zod v4，导入路径 `from "zod/v4"`（不是 `from "zod"`）。禁止使用 v3 API
- **禁止 `as any`**（业务代码），用具体类型或 `as unknown as TargetType` 双重断言
- **Config 响应解包**：用 `unwrapConfigData<T>()`（`web/src/api/config-response.ts`），禁止 `(data as any)?.data`
- **Config body 类型**：必须注册在 `src/schemas/config.schema.ts` 的 `ConfigBodySchema` 中
- **API 响应数组守卫**：`.filter()`/`.map()` 前必须 `Array.isArray()`
- **catch 块必须有 `console.error(err)`**
- 允许例外：测试文件 `as any`、`zodResolver(formConfig.schema as any)`

### 前端约束

- **禁止外部字体链接**：用系统字体栈（`system-ui`, `-apple-system` 等）

### 命名约定

| 类型 | 风格 | 示例 |
|------|------|------|
| 文件名 | kebab-case | `config-service.test.ts` |
| 组件名 | PascalCase | `DataTable`, `FormDialog` |
| 函数名 | camelCase | `storeGetEnvironment` |
| 常量 | UPPER_SNAKE_CASE | `MAX_WS_MESSAGE_SIZE` |
| 状态变量 | camelCase + form 前缀 | `formName`, `formSaving` |

### 目录结构约定

- **后端**：`src/routes/`（按功能分组：v1/v2/web/acp/mcp）、`src/services/`（业务逻辑）、`src/services/config/`（配置 CRUD）、`src/schemas/`（请求验证 schema）、`src/repositories/`（数据访问层）、`src/plugins/`（Elysia 插件）、`src/transport/`（WebSocket/传输）、`src/auth/`（认证）、`src/db/`（Drizzle schema）、`src/__tests__/`
- **前端**：`web/src/routes/`（TanStack Router）、`web/components/`（通用组件，`@/components` alias）、`web/src/pages/`（页面组件）、`web/src/api/`（API 客户端）、`web/src/acp/`（ACP 协议客户端）、`web/src/__tests__/`

### Git 提交风格

Angular 风格（`feat:` / `fix:` / `refactor:` / `test:` / `chore:` / `docs:` / `style:` 等前缀），中文标题。

**提交规范：**

1. 每个提交保持单一职责，一个提交只做一件事
2. 作用域用括号标注，如 `feat(workflow):`、`fix(agent-panel):`、`chore(deps):`
3. 标题简短明确（不超过 80 字符），详细说明放在正文
4. 提交正文格式示例：
   ```
   feat(workflow): 新增看板页面和 Board 管理

   - 添加 WorkflowKanban、BoardSelector 组件
   - 后端 workflow-boards 路由和 repository
   - i18n kanban 命名空间中英双语

   Co-authored-by: GLM <glm@zhipuai.cn>
   ```
5. **Co-authored-by**：使用 AI 辅助编写的提交必须根据实际使用的模型附加 Co-authored-by，放在正文末尾。常见映射：
   - GLM（智谱）→ `Co-authored-by: GLM <glm@zhipuai.cn>`
   - Claude（Anthropic）→ `Co-authored-by: Claude <claude@anthropic.com>`
   - GPT（OpenAI）→ `Co-authored-by: GPT <gpt@openai.com>`
   - Gemini（Google）→ `Co-authored-by: Gemini <gemini@google.com>`
6. 大分支合并前用 `squash merge` 或 `rebase` 压缩提交，按功能模块拆分为 5-15 个有意义的提交，不要保留大量琐碎的中间提交

### React 组件模式

1. `useState` + `useCallback`，避免依赖循环
2. 导航用 `<Link>` 或 `useNavigate()`，禁止 `window.history.pushState`
3. 路由参数：`Route.useParams()`，search params：`Route.useSearch()`
4. 表单：react-hook-form + zod（`FormDialog` 已封装）
5. 异步操作：try-catch + toast + finally 清理 loading
6. 新增页面：`web/src/routes/_app/` 下创建路由文件，lazy import

### 前端路由文件模板

```typescript
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const MyPage = lazy(() => import("../../pages/MyPage").then((m) => ({ default: m.MyPage })));

export const Route = createFileRoute("/_app/my-page")({
  component: () => <Suspense><MyPage /></Suspense>,
});
```

### 后端路由模式

```typescript
const app = new Elysia({ name: "web-resource", prefix: "/web" }).use(authGuardPlugin);

app.post("/resource", async ({ store, body, request }) => {
  const authCtx = (await loadOrgContext(store.user!, request))!;
  // authCtx.organizationId, authCtx.userId, authCtx.role
  return { success: true, data: { ... } };
}, { sessionAuth: true });
```

### 错误处理

- **前端**：`toast.error()` 显示错误（sonner）
- **后端**：`{ error: { type, message } }` 格式
- **环境变量校验**：`src/env.ts` 的 `validateEnv()`，测试环境抛 Error，生产 `process.exit(1)`

## 部署

- Docker 多阶段构建（`Dockerfile`）：deps → build（前端 `build:web` + 后端 `bun build`）→ runtime
- `build-image.sh` 构建镜像（默认 linux/amd64，输出 tar.gz）
- `docker-compose.yml`（开发）/ `docker-compose.prod.yml`（生产）
- 修改 `packages/` 或 `tsconfig.base.json` 后须同步 Dockerfile 的 COPY 范围
- 运行时环境预装 Python3、git、ripgrep（opencode 依赖）

## 文档编写规范

VitePress 构建（`docs/`），分用户文档（`docs/user/`）和开发者文档（`docs/developer/`）。

- 标题扁平（H1-H3，禁止 H4+）
- 中文优先，术语保留原文
- 功能 PR 必须包含文档更新
- 模板：`docs/user/_template.md`、`docs/developer/_template.md`
