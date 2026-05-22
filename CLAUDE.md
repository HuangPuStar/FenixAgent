# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

Remote Control Server (RCS) 是一个基于 Elysia + Bun 的 AI Agent 控制面板后端（package name: `mothership`），配合 React + Vite 前端，使用 PostgreSQL + Drizzle ORM 持久化。核心功能包括：

- **ACP 协议支持**：通过 WebSocket 与 acp-link Agent通信，实现远程 Agent 控制和事件流转发
- **配置管理**：Providers/Models/Agents/Skills/MCP 的动态配置，存储于 PostgreSQL（`src/services/config/` 子模块）
- **多租户**：better-auth organization 插件实现多组织隔离，所有配置和资源以 `organizationId` 为范围，通过 `AuthContext` 传递
- **会话管理**：通过 SSE 向前端推送会话事件，支持 ACP session/list 按 cwd 过滤
- **认证授权**：better-auth + `@better-auth/api-key` 插件，支持用户会话和 acp-link 的 Bearer token
- **定时 HTTP 任务**：cron 调度、执行历史记录、失败重试
- **知识库/工作流引擎/Meta Agent**：知识库管理、DAG 工作流引擎（`@mothership/workflow-engine`）、元智能体编排
- **S3 文件存储**（可选）、**Redis 缓存**（可选）、**Hermes 消息推送**（可选）
- **Workspace Packages**：`packages/` 下有 acp-link、core、plugin-sdk、opencode、workflow-engine 五个内部包

## 常用命令

```bash
bun run dev              # 后端开发（热重载）
bun run dev:web          # 前端开发（Vite dev server，独立进程）
bun run build:web        # 生产构建前端（修改前端代码后必须执行！）
bun run start            # 启动生产服务器
bun run docs:dev         # 文档开发（VitePress）
bun run docs:build       # 构建文档
bun run precheck         # ⚠️ 提交前必须通过（格式化 + import 排序 + tsc + biome check）
bun run typecheck        # 类型检查（仅后端 src/）
bun run typecheck:web    # 类型检查（前端 web/）
bun run lint             # Biome lint 检查
bun run format           # Biome 自动格式化
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
- **严禁手写 SQL 迁移**：所有 schema 变更通过 `src/db/schema.ts` → `drizzle-kit generate` → `push/migrate`
- **环境变量**：新增必须先在 `src/env.ts` 的 `envSchema` 中声明（Zod `zod/v4`）
- **代码质量工具**：Biome v2.4.15 统一 lint + format（`biome.json`），不使用 ESLint/Prettier
- **Swagger API 文档**：`/docs/swagger`，新增路由时添加 `.tags()` 分组
- **工作目录漂移**：Bash `cd web` 后相对路径会出错，使用绝对路径或每次回 cd

## 架构关键点

### 后端架构 (Elysia + Bun)

**入口**：`src/index.ts` — 挂载 `/v1/*`、`/web/*`、`/acp/*` 路由，`/ctrl/*` 静态文件，IP 限流 100 req/min

**认证层**（`src/auth/`）：better-auth + organization + apiKey 插件。`src/plugins/auth.ts` 提供 `authGuardPlugin`（`sessionAuth` macro），`src/services/org-context.ts` 的 `loadOrgContext` 从请求解析 `AuthContext`（`organizationId`/`userId`/`role`）

**配置服务**（`src/services/config/`）：6 张配置表 CRUD，多租户隔离（`AuthContext` 首参 + `organization_id` WHERE）。返回值约定：delete → boolean，get → 对象 | null，list → 数组

**传输层**（`src/transport/`）：`acp-ws-handler.ts`（acp-link 注册）、`relay/` 子模块（中继连接管理）、`event-bus.ts`（事件总线）

**插件层**（`src/plugins/`）：auth、cors、error-handler（`AppError` → HTTP 状态码）、logger（requestId）、rate-limit、static、require-team-scope（`requireOrgScope` 组织资源校验）

**Repository 层**（`src/repositories/`）：数据访问抽象，接口 + 实现模式

**内存存储**（`src/store.ts`）：`environments`/`sessions`/`sessionWorkers`/`tokens` Map。Agent 断开时直接删除记录（不保留 offline）

**错误类**（`src/errors.ts`）：`AppError`（基类）、`ValidationError`(400)、`NotFoundError`(404)、`ConflictError`(409)

### Workspace 自动计算

路径：`{WORKSPACE_ROOT ?? cwd/workspaces}/{organizationId}/{userId}`

- `src/services/workspace-resolver.ts`：`resolveWorkspacePath(orgId, userId)`
- 前端不填 workspace，后端自动计算写入 DB `workspacePath` 列

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

`packages/` 下 5 个内部包（`private: true`，`tsconfig.base.json` 路径映射）：

- **acp-link**：ACP stdio-to-WebSocket 桥接器
- **@mothership/core**：核心运行时抽象（types/registry/runtime/facade）
- **@mothership/plugin-sdk**：插件开发 SDK（engine-plugin/engine-relay 接口）
- **@mothership/opencode**：opencode 引擎插件实现
- **@mothership/workflow-engine**：DAG 工作流引擎（parser/scheduler/executor/recovery/secrets）

### 前端架构 (React + Vite + TanStack Router)

**构建配置**（`web/vite.config.ts`）：Tailwind v4（`@tailwindcss/vite`）、TanStack Router（`@tanstack/router-plugin/vite`，**plugins 数组第一位**）、base path `/ctrl/`、路径别名 `@/src` → `web/src`、`@server` → `../../src`

**路由**（file-based routing，`web/src/routes/`）：
- `_app` 是 pathless layout（v1 控制面板），`_` 前缀不贡献 URL 段
- `_` 后缀（如 `workflow_.$`）是 flat route；`$` 前缀是动态参数
- `__root.tsx` 统一认证检查
- `routeTree.gen.ts` 由 Vite 插件自动生成，**严禁手动编辑**
- 新增页面：在 `web/src/routes/_app/` 下创建路由文件，组件 lazy import
- v2 Agent 面板：`web/src/routes/agent/_panel.tsx`（AgentPanelLayout），`$agentId.tsx` 重定向到 chat

**前端双版本（v1 控制面板 / v2 Agent 面板）**：

| | v1 控制面板 | v2 Agent 面板 |
|---|---|---|
| **入口路由** | `web/src/routes/_app.tsx` | `web/src/routes/agent/_panel.tsx` |
| **Shell** | `web/src/components/shell/`（AppShell、Sidebar、Topbar） | `web/src/pages/agent-panel/`（AgentPanelLayout、AgentSidebar） |
| **布局** | Sidebar（可折叠）+ Topbar + 主内容区 | AgentSidebar（不可折叠）+ ChatPanel + ArtifactsPanel |
| **共享组件** | `web/components/`（chat/、ai-elements/、ui/） | 同左，修改影响两边 |
| **CSS** | `web/src/index.css` | 专有 `agent-panel.css` |

注意事项：
- v2 Sidebar 不支持折叠，不要添加 collapsed 相关逻辑
- OrgSwitcher 被两个版本共用，样式需保持一致

**导航**：`<Link to="/path">` 或 `useNavigate()`，**禁止** `window.history.pushState` / `window.location.href`

**API Client**（`web/src/api/client.ts`）：`credentials: "include"` 携带 session cookie

### 前端 i18n 国际化

react-i18next + i18next，英文默认，中英双语。命名空间见 `web/src/i18n/locales/en/`。

- 语言检测：localStorage `rcs-lang` → `navigator.language`
- 翻译文件：`web/src/i18n/locales/{en,zh}/<namespace>.json`

新增页面 i18n 步骤：
1. 创建 `en/<namespace>.json` 和 `zh/<namespace>.json`
2. 在 `web/src/i18n/index.ts` 中添加 import、`NS` 常量、resources 注册、ns 数组
3. 组件中 `const { t } = useTranslation("<namespace>")`

禁止：硬编码中文字符串（注释除外）、模块级 `i18n.t()` 调用、新建 `*-i18n.test.ts`

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

**开发流程**：修改 `schema.ts` → `bunx drizzle-kit generate` → `bunx drizzle-kit push`（开发）或 `migrate`（生产）

- **禁止手写 SQL 迁移**，会导致快照不一致
- 索引命名：`idx_<表名>_org_<字段>` 格式
- `drizzle-kit generate` 可能需要 TTY 交互，非 TTY 用 `expect` 驱动

## 测试策略

### 后端测试 (Bun test)

路径 `src/__tests__/*.test.ts`，单元测试为主。Mock 使用 `mock.module()`。

**Mock 注意事项**：
1. `mock.module()` 必须在 import 之前调用
2. mock 全局生效，多文件 mock 同一模块可能互相污染（`SyntaxError: Export named 'xxx' not found`）
3. mock 中间件链时须同时 mock `../db` 和 `../auth/better-auth`
4. `src/store.ts` 纯内存 Map，测试直接 `storeReset()` 清理
5. 禁止直接连接数据库的集成测试，用 mock 替代

### 前端测试 (Bun test)

路径 `web/src/__tests__/`，React Testing Library + ReactDOMServer。文件路径用 `import.meta.dirname` 构建（不用相对路径字符串）。

注释规范：每个 `test(...)` 上方补一行中文注释。

### tsconfig

后端 extends `tsconfig.base.json`（workspace 路径别名），前端独立 `web/tsconfig.json`（`jsx: "react-jsx"`，`@/*` → `./*`）。

## 状态字段映射

两套 StatusBadge，状态值不同：
- `web/src/components/Navbar.tsx`：会话/环境状态（active/running/idle/inactive 等）
- `web/components/config/StatusBadge.tsx`：配置页状态（configured/enabled/unconfigured/disabled 等）

## 常见陷阱

1. **前端修改未生效**：后端挂载 `web/dist/`，修改后必须 `bun run build:web`
2. **配置写入竞争**：`config-pg.ts` 无分布式锁，并发 upsert 可能竞态
3. **WebSocket 断连**：反向Agent timeout 需 > 30s（Bun idleTimeout 默认）
4. **状态 Badge 混淆**：两个不同文件的 StatusBadge，状态值不同
5. **acp-link spawn 认证**：本地 WS 始终 auth，自动生成 64 位 hex token。relay 连接时须从 stdout 用正则 `Token:\s*([a-f0-9]{64})` 捕获，不能假设环境 secret 复用
6. **acp-link 端口残留**：服务器重启不会杀旧进程，`EADDRINUSE` 导致 spawn 失败，需先清理
7. **acp-link standalone 模式**：spawn 时不设 `ACP_RCS_URL`，opencode 子进程由 relay 连接触发启动
8. **relay 断连不杀进程**：前端断连只关 WS，不终止 acp-link 进程
9. **keep_alive 不透传前端**：relay 层拦截，否则前端报 "Unknown message type: keep_alive"
10. **文件 API 路径**：`/web/sessions/:id/user/*`（不是 `/files/*`）
11. **API 响应兼容**：改造格式时保留旧字段直到前端全部迁移
12. **多实例 relay 路由**：`agentLocalWsMap` 按 instanceId 做 key，relay URL 须 `?sessionId=`
13. **Split Button 可见性**：多实例下拉按钮应在环境在线时就显示
14. **ACP vs RCS session ID**：ACP 返回 `ses_xxx`，RCS 用 `session_xxx`/`cse_xxx`。文件 API 须用 RCS ID（`resolveExistingSessionId` 转换）
15. **resolveWorkspacePath 不做 fallback**：session 找不到时返回 404，不 fallback 到第一个 environment
16. **ChatInterface 有两处 ChatInput**：修改 sessionId 传递时必须两处都改
17. **FilePickerDialog 上传始终到 user/**：不管浏览哪个目录
18. **Workflow 节点 inputs 引用**：引用的变量必须在 `depends_on` 依赖的节点中存在
19. **requireOrgScope 校验链路**：新增 organization 级资源路由必须调用 `requireOrgScope`
20. **@noble/ciphers 替代 crypto.subtle**：HTTP 环境下加密用 `@noble/ciphers`
21. **routeTree.gen.ts 严禁手动编辑**：由 Vite 插件自动生成
22. **TanStack Router Vite 插件顺序**：`TanStackRouterVite` 必须在 `plugins` 数组第一位
23. **createFileRoute 路径自动修正**：插件会自动修正路由 ID，不需要手动对齐
24. **Sidebar 导航项必须有 `to` 字段**：有 `to` 渲染 `<Link>`，没有则渲染 `<button>`
25. **AgentPanelLayout 路由参数**：`agentId`/`sessionId` 从路由参数注入，v2 路由在 `routes/agent/_panel/` 下

## 代码风格

### Biome（lint + format）

Biome v2.4.15，space indent 2，lineWidth 120。`noExplicitAny: warn`，`noNonNullAssertion: off`，`useConst: error`。测试目录宽松处理。

#### biome-ignore 使用规范

- **禁止对 biome-ignore 行做 `--write` 自动修复**：会误删 suppression 注释，连带破坏类型断言（如 `client.web` 的 `as ... & { web: any }`）
- **precheck 的 `--write` 只用于格式化和 import 排序**（`--linter-enabled=false`）
- biome 报 `suppressions/unused` warning 时，确认代码仍需该 suppression 后保留

### TypeScript 类型规范

- **禁止 `as any`**（业务代码），用具体类型或 `as unknown as TargetType` 双重断言
- **Eden Treaty 类型降级**：`const client = _client as typeof _client & { web: any }`，必须配合 `biome-ignore` 注释
- **Config 响应解包**：用 `unwrapConfigData<T>()`（`web/src/api/config-response.ts`），禁止 `(data as any)?.data`
- **Config body 类型**：必须注册在 `src/schemas/config.schema.ts` 的 `ConfigBodySchema` 中
- **Eden Treaty 路径命名**：连字符路由转 camelCase（`/web/knowledge-bases` → `client.web.knowledgeBases`）
- **API 响应数组守卫**：`.filter()`/`.map()` 前必须 `Array.isArray()`
- **catch 块必须有 `console.error(err)`**
- 允许例外：测试文件 `as any`、`zodResolver(formConfig.schema as any)`、Eden `{ web: any }`

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

- **后端**：`src/routes/`（按功能分组：v1/web/acp）、`src/services/`（业务逻辑）、`src/services/config/`（配置 CRUD）、`src/repositories/`（数据访问层）、`src/plugins/`（Elysia 插件）、`src/transport/`（WebSocket/传输）、`src/auth/`（认证）、`src/db/`（Drizzle schema）、`src/__tests__/`
- **前端**：`web/src/routes/`（TanStack Router）、`web/src/components/`（通用组件）、`web/src/pages/`（页面组件）、`web/src/api/`（API 客户端）、`web/src/acp/`（ACP 协议客户端）、`web/src/__tests__/`

### 代码组织模式

- **功能驱动提交**：一个 commit 包含端到端功能（后端 + API 路由 + 前端 + 测试）
- **配套测试**：每个功能提交包含单元测试

### Git 提交风格

```
<type>: <简洁的中文标题>

<详细变更列表，每行以 - 开头>

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

类型前缀：`feat:` 新功能、`fix:` 修复、`refactor:` 重构、`test:` 测试

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

- **前端**：`toast.error()` 显示错误
- **后端**：`{ error: { type, message } }` 格式
- **环境变量校验**：`src/env.ts` 的 `validateEnv()`，测试环境抛 Error，生产 `process.exit(1)`

## 文档编写规范

VitePress 构建（`docs/`），分用户文档（`docs/user/`）和开发者文档（`docs/developer/`）。

- 标题扁平（H1-H3，禁止 H4+）
- 中文优先，术语保留原文
- 功能 PR 必须包含文档更新
- 模板：`docs/user/_template.md`、`docs/developer/_template.md`
