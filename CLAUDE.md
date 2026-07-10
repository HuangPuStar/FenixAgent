# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

> ⚡ 速查：提交前 `bun run precheck` / 改前端后 `bun run build:web` / 改 schema 后 `bun run db:generate --name <name>` + `bun run db:migrate` / 先看下方“高风险陷阱”

## 规范入口

- 前端开发规范：`docs/developer/guide/frontend-development.md`
  - 覆盖前端目录结构、路由导航、状态管理、组件、API、i18n、样式规范
- 后端开发规范：`docs/developer/guide/backend-development.md`
  - 覆盖后端目录分层、数据库、API、注释、日志规范
- 本文件只保留高频速查、跨前后端约束、项目特有 gotcha
- 若本文件与更细粒度规范冲突，以离代码更近、约束更具体的文档为准

## 项目概览

FenixAgent 是基于 Elysia + Bun 的 ACP Agent 平台，前端为 React 19 + Vite，数据库为 PostgreSQL + Drizzle ORM。

- 主要能力：多租户组织、Agent 配置、ACP 实时通信、工作流、知识库、定时任务、IM 通道
- 依赖结构：`web/` 没有独立 `package.json`，前后端依赖统一在根 `package.json`
- workspace 包：`packages/` 下当前有 11 个内部包

## 仓库结构

### 后端

- `src/index.ts`：服务入口
- `src/routes/web/`：控制台内部 API
- `src/routes/api/`：对外 OpenAPI
- `src/routes/acp/`：ACP WebSocket / relay
- `src/routes/mcp/`：MCP 入口
- `src/routes/hooks.ts`：Webhook
- `src/services/`：业务逻辑
- `src/repositories/`：数据访问层
- `src/schemas/`：请求/响应 schema
- `src/transport/`：WS / SSE / relay / EventBus
- `src/db/`：Drizzle schema 和数据库接入
- `src/__tests__/`：后端测试

### 前端

- `web/src/routes/`：TanStack Router 文件路由
- `web/src/pages/`：页面组件
- `web/components/`：通用组件
- `web/src/api/`：前端 API 模块
- `web/src/acp/`：ACP 客户端
- `web/src/i18n/`：国际化
- `web/src/__tests__/`：前端测试

## 常用命令

```bash
bun run dev                         # 后端开发
bun run dev:web                     # 前端开发
bun run build:web                   # 前端生产构建；改前端后必须执行
bun run docs:dev                    # 本地文档开发
bun run docs:build                  # 文档构建
bun run precheck                    # 提交前必跑：格式化、排序、类型和 lint 检查
bun run check:deps                  # 依赖健康检查
bun run db:generate --name <name>   # 生成 Drizzle 迁移
bun run db:migrate                  # 执行迁移
```

### 测试

```bash
bun test src/__tests__/
bun test src/__tests__/store.test.ts
bun test web/src/__tests__/
bun test web/src/__tests__/config-mcp-page.test.ts
```

## 前端速查

- 路由：TanStack Router，新增页面放 `web/src/routes/agent/_panel/`
- 导航：只能用 `<Link to>`、`useNavigate()`、`router.invalidate()`
- 禁止：`window.location.href`、`window.location.replace`、`window.location.reload`、`window.history.pushState`
- `routeTree.gen.ts` 严禁手改
- 数据获取优先遵循前端规范；当前项目已大量使用 `ahooks` `useRequest`
- i18n：`web/` 下用户可见字符串一律走 `t()`，不要在 JSX 里硬编码
- UI：
  - 基础组件优先复用 `web/components/ui/`
  - 通用图标只用 `lucide-react`
  - 模型品牌图标统一通过 `web/components/model-icon/ModelIcon.tsx`
- API：
  - 前端请求统一走 `web/src/api/request.ts`
  - `request<T>()` 已自动做路径参数、query、JSON、错误标准化、响应解包
  - `/web/config/*` 多为 action 风格；其他 `/web/*` 可能是 RESTful 或混用，写前先对照后端路由
- 路径别名：
  - `@/src` → `web/src`
  - `@/components` → `web/components`
  - `@server` → `../src`
  - `@fenix/sdk` → `packages/sdk/src/index.ts`

## 后端速查

- 分层默认遵循：`routes -> services -> repositories -> db`
- route 只做协议接入、鉴权、参数校验、响应映射
- service 负责业务编排、事务边界、跨表操作、外部调用
- repository 只做数据访问，不承载业务规则
- `/web/*`：
  - 给控制台前端使用
  - 默认返回 `{ success, data }` 或 `{ success: false, error }`
- `/api/*`：
  - 给外部系统和 API Key 调用方使用
  - 必须优先保证向后兼容
- 内部协议能力不要混进 `/web` 或 `/api`，应放 `acp`、`mcp`、`hooks`、`skills` 等独立前缀
- 新接口默认同时补齐 OpenAPI 元数据：`detail`、`params`、`query`、`headers`、`body`、`response`
- schema 定义放 `src/schemas/`，不要在 route 内联复杂结构

### Agent 通信：统一 service 层（重要）

Agent 通信的 ACP 协议栈只有一套权威实现，所有入口必须复用，禁止各自重写。

| 组件 | 文件 | 角色 |
|------|------|------|
| `agent-chat-service` | `src/services/agent-chat-service.ts` | **权威 ACP 服务层**：提供 `createAgentSession`（封装 relay handle）、`startPromptTurn`（session/new → PromptTurn）、`openAgentSession`（一站式 spawn → relay → turn）。所有入口共用 |
| `agent-chat-transport` | `src/services/workflow/agent-chat-transport.ts` | Workflow 的 `Transport` 适配器：内部调用 `ensureRunning` + `connectAgentRelay` + `createAgentSession` + `startPromptTurn`，通过 `PromptTurn.events()` 收集流式输出，适配为 `Transport` 接口 |
| `openai-chat.ts` | `src/routes/api/openai-chat.ts` | OpenAI HTTP 兼容端点：直接调用 `openAgentSession` |
| `acp/relay` WS 端点 | `src/routes/acp/` + `src/transport/relay/` | 前端 Chat UI 的 WS relay：走 `connectAgentRelay` + 独立的 session 管理 |

**关键约束**：

1. **不要绕过 `agent-chat-service` 自己写 ACP 协议。** 已删除的 `acp-transport.ts`（467 行独立 JSON-RPC 实现）就是反面案例。
2. relay 消息统一用 `extractJsonRpc()` 模式解析，兼容两种格式：
   - 原始 JSON-RPC：`{ jsonrpc: "2.0", method/result, ... }`
   - 包裹格式：`{ type: "...", payload: { jsonrpc: "2.0", ... } }`
3. session_update 通知的文本在 `params.update.sessionUpdate` 路径，不要到 `payload.update` 查找。
4. 实例策略有两条路径，不可混用：
   - `ensureRunning("system", envId)`：workflow 场景，复用已有实例，workflow 结束后统一销毁
   - `spawnInstanceFromEnvironment(userId, agentId)`：HTTP API 场景，每次新建独立实例，dispose 时销毁

## 数据库与迁移

- Schema 真相来源：`src/db/schema.ts`
- 默认流程：
  1. 修改 `src/db/schema.ts`
  2. `bun run db:generate --name <name>`
  3. `bun run db:migrate`
  4. 提交 `drizzle/` 整个目录
- 生产迁移入口：`scripts/migrate.ts` 构建出的 `migrate.js`
- 禁止：
  - 手写 SQL 迁移绕过 Drizzle
  - 在生产环境使用 `db:push`
  - 提交迁移时漏掉 `drizzle/meta/*`

## 测试约束

- 后端测试在 `src/__tests__/`
- 前端测试在 `web/src/__tests__/`
- 禁止在测试文件中直接用 `mock.module()`；优先复用 `src/test-utils/`
- 前端只测关键流程，不写纯 UI 结构断言和类型检查测试
- 每个 `test(...)` 上方补一行中文注释

## 高风险陷阱

### 通用

1. `bun run precheck` 是提交前第一标准。
2. 修改前端后必须执行 `bun run build:web`，因为后端静态挂载 `web/dist/`。
3. `web/` 没有独立依赖清单，安装和升级依赖都在根目录执行。
4. Bash 进入子目录后容易发生相对路径漂移，尽量用仓库根目录绝对路径。

### ACP / Runtime

1. `acp-link` 本地 WS 始终需要认证，relay 要从 stdout 捕获自动生成的 token。
2. 服务重启不会自动清理旧 `acp-link` 进程，残留端口会触发 `EADDRINUSE`。
3. relay 断连只断 WS，不会杀掉 agent 子进程。
4. relay 必须转发 agent `status`，前端依赖 `status.capabilities` 判断能力。
5. ACP session id 是 `ses_xxx`，RCS session id 是 `session_xxx` / `cse_xxx`；文件 API 必须使用 RCS id。
6. **session/update 二级结构**：`update.sessionUpdate` 是事件类型字符串（如 `"agent_message_chunk"`），`update.content` 是载荷对象（`{ type, text }`）。**不要把事件类型值当 key 写**（如 `update.agent_message_chunk`）。写 ACP 消息处理代码前，先 `grep agent_message_chunk` 看已有消费者做参照。

### Workspace / Skill

1. workspace 路径运行时实时计算：`{WORKSPACE_ROOT}/{organizationId}/{userId}/{environmentId}`。
2. 不要依赖 DB `workspacePath` 历史字段推导真实目录。
3. Skill 是 PG 元数据 + 文件系统双存储；必须通过 `setSkill` 或 `importSkillDirectories` 创建。
4. 直接调 `upsertSkill` 只会写 DB，不会把 skill 下发到文件系统。

### API / 前后端联动

1. 前端 URL 必须走 `/web/*`，不要再写历史 `/v1`、`/v2` 前缀。
2. 配置接口 `POST /web/config/:module` 仍是 action 风格，不要擅自改成新协议。
3. 同一个后端路由文件里可能混用 RESTful 和 action 风格，写前先看实际 route。
4. 前端类型要和后端真实返回保持一致，不要补“幻影字段”。
5. 允许空字符串的默认值必须优先使用 `??`，不要用 `||`。

### 前端实现

1. `routeTree.gen.ts` 严禁手改。
2. Sidebar 导航项必须有 `to` 字段。
3. `FilePickerDialog` 上传目标始终是 `user/`。
4. `@lobehub/icons` 不要被后端或纯逻辑测试间接加载；纯工具逻辑要拆到不依赖 UI 的独立模块。
5. 代码库里仍可能有少量历史写法与规范不一致；新改动按规范收敛，不要继续扩散旧模式。
6. **i18n 插值语法**：i18n 配置（`web/src/i18n/index.ts:160`）未自定义 prefix/suffix，必须用 `{{var}}`（双花括号），`{var}` 会被当字面文本。写翻译前先看同 namespace 已有占位符写法做参照。

## 项目特有约束

### 认证与组织

- 认证优先级：better-auth session cookie → API Key → Environment Secret → 全局 `RCS_API_KEYS`
- 组织 ID 提取优先级：`x-active-org-id` header → query → cookie
- 测试可通过 `setTestAuth()` 和 `setTestOrgContext()` 绕过

### Agent 模板

- 模板目录：`.agents/agents/`
- 文件格式：Markdown + YAML frontmatter
- 解析方式：必须使用 `gray-matter`，禁止手写正则

### Permission 系统

- 三态：`ask` / `allow` / `deny`
- 规则型工具支持通配符
- 开关型工具只支持三态

## 代码风格

### 注释与文档注释

- 注释只写真正有价值的信息：设计原因、边界条件、兼容性、临时取舍
- 公共函数、公共方法、导出工具、类型定义应有清晰文档注释
- 复杂函数可按阶段补少量结构性注释，但不要重复代码表面含义

### TypeScript

- Zod 使用 `zod/v4`
- 业务代码禁止 `as any`
- 允许空字符串的默认值优先用 `??`
- `catch` 块必须保留足够上下文，避免吞错

### 命名

- 文件：kebab-case
- 组件：PascalCase
- 函数：camelCase
- 常量：UPPER_SNAKE_CASE

### Git

- 提交风格：Angular 风格 `feat:` / `fix:` / `refactor:` / `test:` / `chore:` / `docs:`
- 标题用中文
- 代码改动提交前必须先跑 `bun run precheck`

## 环境变量

- `DATABASE_URL`
- `RCS_SECRET_<name>`
- `SKILL_DIR`，默认 `./data/skills`
- `WORKSPACE_ROOT`，默认 `./workspaces`
- `RCS_SYSTEM_ADMIN_PASSWORD_FILE`，默认 `data/password.txt`
- `RCS_ACP_IDLE_TIMEOUT_SECONDS`
- `RCS_ACP_IDLE_SWEEP_INTERVAL_SECONDS`
- `RCS_ACP_ACTIVITY_TIMEOUT_SECONDS`
