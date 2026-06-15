# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **⚡ 速查**：提交前 `bun run precheck` / 改 schema 后 `bun run db:generate` + `db:push` / 改前端后 `bun run build:web` / [常见陷阱](#常见陷阱) 16 条必读，违反直接导致 bug

## 项目概述

Remote Control Server (RCS) 是一个基于 Elysia + Bun 的 AI Agent 控制面板后端（package name: `fenix`），配合 React 19 + Vite 前端，使用 PostgreSQL + Drizzle ORM 持久化。支持多租户组织隔离（better-auth）、ACP 协议实时通信、DAG 工作流引擎、知识库管理、定时任务、IM 通道集成。可选依赖：S3 文件存储、Redis 缓存、Hermes 消息推送。`packages/` 下当前有 9 个内部 workspace 包。

**依赖结构**：`web/` 没有独立的 `package.json`，所有前后端依赖统一在根 `package.json` 管理。前端代码在 `web/` 但依赖安装/升级都在根目录执行。

## 功能模块

产品以 Agent 为核心，围绕 **配置 → 运行 → 编排 → 集成** 四层组织：

### 基础设施层

| 模块 | 路由/目录 | 说明 |
|------|-----------|------|
| **认证授权** | `src/auth/` + `src/plugins/auth.ts` | better-auth 用户登录/注册 + organization 多租户 + API Key（`rcs_xxx`）三路认证 |
| **多租户组织** | `/web/organizations` | 组织 CRUD、成员邀请、角色管理（owner/admin/member）、组织切换、品牌定制（logo + 名称） |
| **API Key 管理** | `/web/auth` → `/agent/apikeys` 页面 | 创建/撤销 API Key，设置过期时间，SHA-256 哈希存储 |
| **机器注册表** | `/web/registry` | 机器注册与状态追踪、事件历史、标签过滤（`machine` + `registryEvent` 表） |

### Agent 配置层

| 模块 | 路由/目录 | 说明 |
|------|-----------|------|
| **Provider 配置** | `/web/config/providers` | LLM 供应商配置（API Key、endpoint、自定义参数），密钥用 `{env:RCS_SECRET_<name>}` 占位 |
| **Model 配置** | `/web/config/models` → `/agent/models` 页面 | AI 模型定义（上下文限制、费用、模态），支持批量测试连接 |
| **Agent 配置** | `/web/config/agents` | Agent 行为配置（系统提示、权限规则、工具访问控制、默认模型） |
| **Skill 管理** | `/web/config/skills` → `/agent/skills` 页面 | Skill 创建/上传/启用/禁用，元数据 PG + 内容文件系统双层存储 |
| **MCP Server** | `/web/config/mcp` → `/agent/mcp` 页面 | MCP 服务器配置（local stdio / remote streamable-http），工具检查、OAuth 凭证管理 |
| **Permission 系统** | `src/schemas/` | 三态权限（ask/allow/deny），规则型工具支持通配符，开关型工具仅三态 |

### Agent 运行层

| 模块 | 路由/目录 | 说明 |
|------|-----------|------|
| **Environment 管理** | `/web/environments` | Agent 运行环境 CRUD，含 auto-start、secret 生成、workspace 自动创建 |
| **Instance 管理** | `/web/instances` + `/web/environments/:id/instances` | 环境内实例 spawn/stop/list，多实例并发运行，`ensureRunning()` 并发安全 |
| **Session 管理** | `/web/sessions` + `/v1/code/sessions` + `/v2/session_ingress` | 会话创建/列表/桥接事件推送，ACP session/list 按 cwd 过滤 |
| **Chat 交互** | `/agent/chat/$agentId` 页面 + `/acp/relay/:agentId` | 实时聊天界面，WebSocket relay 中继，ArtifactsPanel 展示输出 |
| **ACP 协议** | `/acp/ws` + `/acp/relay` | acp-link 注册（NDJSON）、前端中继桥接、keep_alive + 超时检测 |
| **文件管理** | `/web/sessions/:id/user/*` + `/web/s3-files` | 用户工作区文件读写上传、目录浏览、S3 存储（presigned URL） |
| **控制指令** | `/web/control` | 向 Agent 发送权限请求、中断指令等控制消息 |

### 编排自动化层

| 模块 | 路由/目录 | 说明 |
|------|-----------|------|
| **DAG 工作流** | `/web/workflow-*` + `/workflow-ui/*` → `/agent/workflow` 页面 | YAML 定义 + 可视化 DAG 编辑器、多版本管理、参数化执行、dry run |
| **Workflow Board** | `/web/workflow-boards` | 看板式作业管理，拖拽流转阶段（Ready → Running → Suspended → Completed） |
| **Workflow Jobs** | `/web/workflow-jobs*` + `/web/workflow-stats` | 作业创建/执行/日志/重试，SSE 实时事件流 |
| **Workflow Triggers** | `/web/workflow-defs` | Webhook 触发器，外部系统自动触发工作流执行 |
| **定时任务** | `/web/tasks` → `/agent/tasks` 页面 | cron 表达式调度 HTTP 任务、执行日志、手动触发、启用/禁用 |
| **Meta Agent** | `/web/meta-agent` | 自举式元智能体：自动创建 Environment + AgentConfig + Skill → spawn 实例 |

### 知识与集成层

| 模块 | 路由/目录 | 说明 |
|------|-----------|------|
| **知识库** | `/web/knowledge-bases` → `/agent/knowledge-bases` 页面 | 知识库 CRUD、文件/URL 上传、Agent 绑定、语义检索 |
| **MCP 查询** | `/mcp/*` | MCP 协议端点，Agent 通过 Bearer token 查询知识库内容 |
| **IM 通道**（开发中） | `/web/channels` → `/agent/channels` 页面 | 微信/飞书等多平台消息接入，通道与 Agent 路由绑定 |
| **Webhook** | `/hooks/:publicHash` | 外部 webhook 触发（无认证），按 publicHash 路由 |
| **Share Link** | 数据库 `shareLink` + `shareEventSnapshot` 表 | 会话快照分享 |

### 前端页面结构

Agent 面板（`/agent/*`）统一布局：**AgentSidebar**（左）+ **ChatPanel**（中）+ **ArtifactsPanel**（右，可调宽度）

**Sidebar 导航分组**：
- **快捷配置**：Models / Skills / MCP / Organizations
- **Agent 树**：展开式 Agent 卡片 + 实例列表 + Session 入口
- **更多菜单**：Dashboard / Workflow / Sessions / Knowledge Bases / Tasks / API Keys / Channels

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

### 关键注意事项

- **`bun run precheck` 是代码质量的第一标准**。流程：`biome format --write` → `biome check --write --linter-enabled=false`（import 排序）→ `tsc` → `biome check`。格式和 import 排序自动修复
- 后端挂载 `web/dist/` 提供前端静态文件，修改前端后**必须** `bun run build:web`
- **工作目录漂移**：Bash `cd web` 后相对路径会出错，使用绝对路径或每次回 cd
- 首次启动会自动引导系统管理员 `admin@fenix.com`，随机密码写入 `RCS_SYSTEM_ADMIN_PASSWORD_FILE`（默认 `data/password.txt`）

### 关键环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `DATABASE_URL` | PostgreSQL 连接串 | — |
| `RCS_SECRET_<name>` | Provider API Key 密文（通过 `{env:RCS_SECRET_<name>}` 引用） | — |
| `SKILL_DIR` | Skill 文件系统存储目录 | `./data/skills` |
| `WORKSPACE_ROOT` | 工作区根目录 | `./workspaces` |
| `RCS_SYSTEM_ADMIN_PASSWORD_FILE` | 首次启动管理员密码存放路径 | `data/password.txt` |

## 架构关键点

### 后端架构 (Elysia + Bun)

**路由前缀→源码映射**：

- `/v1/code/sessions/*`：Code Session / Worker API，源码位于 `src/routes/v2/`（`code-sessions`、`worker`、`worker-events`、`worker-events-stream`）
- `/v2/session_ingress/*`：Session bridge HTTP / WebSocket 入口（源码位于 `src/routes/v2/session-ingress.ts`）
- `/web/*`：控制面板业务 API 聚合入口（`src/routes/web/index.ts`），下挂 `auth`、`branding`、`channels`、`config/*`、`control`、`environments`、`files`、`instances`、`knowledge-bases`、`meta-agent`、`organizations`、`registry`、`s3-files`、`sessions`、`skills`、`tasks`、`user-file`、`workflow-*`
- `/acp/*`：ACP WebSocket / relay 路由（`src/routes/acp/index.ts`）
- `/mcp/*`：MCP 知识库查询（`src/routes/mcp/knowledge.ts`）
- `/hooks/*`：Webhook 触发（`src/routes/hooks.ts`，无认证）
- 非 `/web` 前缀的 Workflow 相关入口：`/workflow-ui/*` 与 `/api/v1/*` 从 `src/routes/web/workflow-proxy.ts` 挂载

**认证优先级**：better-auth session cookie → API Key（`rcs_xxx`）→ Environment Secret → 全局 `RCS_API_KEYS`。组织 ID 从 `x-active-org-id` header > query param > cookie 提取，缓存 60s。测试通过 `setTestAuth()` + `setTestOrgContext()` 绕过

**传输层**（`src/transport/`）：ACP WS Handler（acp-link 注册）→ Relay（Instance 模式优先，EventBus fallback）→ EventBus（per-session 隔离，支持 SSE 断线重连）

### Workspace 自动计算

路径：`{WORKSPACE_ROOT ?? cwd/workspaces}/{organizationId}/{userId}/{environmentId}`

- `src/services/workspace-resolver.ts`：`resolveWorkspacePath(orgId, userId, envId)`
- workspace 路径运行时实时计算，不依赖 DB `workspacePath` 字段
- 新 environment 的 `workspacePath` 列写空字符串，旧 environment 的为历史值

### ACP 协议要点

**关键约定**（违反会直接导致 bug）：

1. **acp-link spawn 认证**：本地 WS 始终 auth，自动生成 64 位 hex token，relay 须从 stdout 正则捕获
2. **acp-link 端口残留**：服务器重启不会杀旧进程，需先清理否则 `EADDRINUSE`
3. **relay 断连不杀进程**：前端断连只关 WS，不终止 acp-link
4. **ACP vs RCS session ID**：ACP 返回 `ses_xxx`，RCS 用 `session_xxx`/`cse_xxx`，文件 API 须用 RCS ID
5. **relay 必须转发 agent `status`**：前端依赖 `status.capabilities` 判断 ACP 能力，丢弃会导致功能缺失
6. **Skill 必须通过 `setSkill`/`importSkillDirectories` 创建**：直接调 `upsertSkill` 只写 DB 不写文件系统，会导致 skill 不下发

### Workspace Packages

`packages/` 下当前有 9 个内部包（`private: true`，`tsconfig.base.json` 路径映射）：`acp-link`、`@fenix/core`（运行时抽象）、`@fenix/logger`、`@fenix/plugin-sdk`、`@fenix/opencode`、`@fenix/ccb`、`@fenix/remote-runtime`、`@fenix/sdk`（前端 API SDK）、`@fenix/workflow-engine`

### 前端架构 (React 19 + Vite + TanStack Router)

**UI 技术栈**：Radix UI（通过 shadcn/ui 包装，`web/components/ui/`，禁止手写 Radix 原生组件）、lucide-react（**通用 UI 图标唯一来源**，禁止内联 SVG）、`@lobehub/icons`（**AI 模型/品牌图标来源**，200+ LLM 品牌 SVG 组件，所有图标本地打包不使用 CDN）、Tailwind CSS v4、Vercel AI SDK（`ai` + `@ai-sdk/react`，消息类型 `UIMessage`/`UIMessageChunk`）

**模型图标对照表**（`web/components/model-icon/`）：

- `model-icon-map.ts`：模型 ID → `@lobehub/icons` 组件的显式对照表（仅收录常用主流模型：OpenAI/Claude/Gemini/DeepSeek/Qwen/Kimi/Meta Llama/Mistral/Grok），正则匹配模型 ID 前缀，自上而下首次命中即返回。新增模型时在此追加规则
- `ModelIcon.tsx`：`<ModelIcon modelId="gpt-4o" size={16} />`，优先查本地对照表，未命中兜底到 `@lobehub/icons` 内置 `ModelIcon` helper（内置 400+ 关键字匹配）。禁止在业务代码中直接 import `@lobehub/icons` 的图标组件，统一通过 `<ModelIcon>` 渲染

**路径别名**：`@/src` → `web/src`、`@/components` → `web/components`、`@server` → `../src`、`@fenix/sdk` → `packages/sdk/src/index.ts`

**路由规则**（file-based，`web/src/routes/`）：`_` 前缀不贡献 URL 段、`$` 前缀是动态参数、`routeTree.gen.ts` 严禁手动编辑、新增页面在 `web/src/routes/agent/_panel/` 下创建

**导航**：`<Link to>` 或 `useNavigate()`，**禁止** `window.history.pushState` / `window.location.href` / `window.location.replace` / `window.location.reload`。页面跳转和刷新一律通过 TanStack Router 的 `navigate()` 或 `router.invalidate()` 完成，`window.location` 仅允许用于读取（`pathname`/`search`/`host`/`protocol`）

**API Client**（`web/src/api/sdk.ts`）：类架构 SDK，通过 `import { envApi, sessionApi } from "@/src/api/sdk"` 使用，`credentials: "include"`

### 前端 i18n 国际化

react-i18next + i18next，英文默认，中英双语。适用范围：**所有 `web/` 下 TSX 文件无例外**。

- 命名空间：用 `NS` 常量（`useTranslation(NS.AGENT_PANEL)`），不要用字符串字面量。公共组件用 `"components"` 命名空间，页面专属用对应页面命名空间
- 翻译文件：`web/src/i18n/locales/{en,zh}/<namespace>.json`
- 新增命名空间：1) 创建 en/zh JSON 文件 → 2) 在 `web/src/i18n/index.ts` 注册 → 3) 组件中用 `NS` 常量

**硬编码规则**：禁止在 JSX 中硬编码用户可见字符串（按钮、标题、placeholder、错误提示、toast、`title`/`aria-label` 属性），一律走 `t()`。中文注释和 `console.log` 不受限制。禁止模块级 `i18n.t()` 调用、新建 `*-i18n.test.ts`

## 配置存储

配置 API：`POST /web/config/:module`（providers/models/agents/skills/mcp），action 分发（list/get/set/create/delete/enable/disable），响应 `{ success, data }` 或 `{ success, error: { code, message } }`。

## API 设计约定

新增接口、修改接口或重写 route 时，先满足下面这些 API 设计约束，再补文档元数据。

### 设计规则

- API 功能必须单一、明确。正常情况下不要在一个接口里通过 `action` 等字段分支处理不同业务行为；只有明确要求，或 WebSocket / 长连接事件流这类天然多消息类型场景，才允许这样设计。
- API 分为两类：面向控制台前端使用的 `/web/*` API，以及通过 API Key 提供给外部系统访问的 OpenAPI。设计、命名、鉴权和兼容性判断时必须先明确接口属于哪一类。
- 对外 OpenAPI 路径统一放在 `/api/*` 下，不要把面向外部系统的接口散落到其他前缀中。
- 对外 OpenAPI 必须向后兼容；如果新的实现无法兼容旧协议，不要直接修改旧接口，应新增新的 API 接口或新版本接口。

### 风格规则

- URL 使用小写 kebab-case，资源名优先用复数，例如 `/web/knowledge-bases`、`/api/agents`，不要混用驼峰、下划线和复数单数风格。
- URL 表达资源，动作用 HTTP 方法表达；正常情况下不要写成 `/create`、`/update`、`/delete` 这类动词路径。确实不是标准 CRUD 的行为，使用明确的动作后缀，例如 `POST /api/sessions/:id/cancel`。
- 路径参数只放资源标识和层级关系，例如 `:id`、`:sessionId`；筛选、分页、排序、开关类参数放 `query`，不要混进路径里。
- `GET` 只做查询，不带请求体；`POST` 用于创建或触发动作；更新统一使用 `PUT`；`DELETE` 用于删除。
- 请求体只承载本次操作的业务数据，不要再包一层 `data`、`payload`、`params` 之类的无意义壳；只有历史兼容场景才允许保留。
- 分页参数统一优先使用 `page`、`pageSize`；排序参数统一优先使用 `sortBy`、`sortOrder`；布尔筛选参数使用语义化命名，例如 `includeDisabled`、`withMembers`。
- 控制台内部 `/web/*` API 默认返回 `{ success: true, data }` 或 `{ success: false, error }`；没有业务数据时也优先返回 `{ success: true, data: ... }`，避免同一类接口有时返回 `data`、有时完全不返回。
- 错误响应统一返回 `error` 对象，至少包含 `code` 和 `message`；需要补充上下文时再增加字段，不要直接返回裸字符串或格式不固定的对象。
- 对外 OpenAPI 返回结构要稳定、可预测，列表接口优先返回对象结构而不是裸数组；至少明确区分列表数据和分页元信息，例如 `{ items, total, page, pageSize }`。
- 新接口必须遵循这套风格；历史接口如果暂时不一致，先保持兼容，不要为了“统一风格”直接改坏已有调用方。

## API 文档约定

本仓库默认使用 OpenAPI + Scalar 展示接口文档。新增接口、修改接口或重写 route 时，必须同步把文档元数据写完整，不能等到后面再补。

### 开发目标

- 让新写出来的 API 默认就是可展示、可理解、可调试的
- 让 route、schema、全局 tags 的说明保持一致

### 写 API 时必须同步完成的内容

- 在 route 上补充 `detail`
- 在 route 上显式声明 `params`、`query`、`headers`、`body`、`response`
- 为 schema、字段、请求体、响应体补充描述信息
- 为 OpenAPI 展示补充必要的 `model` 注册
- 为所属 OpenAPI 全局 `tag` 补充中文 `description`；全局 tag 定义统一维护在 `src/index.ts` 的 OpenAPI `documentation.tags` 中

### 编写规则

- `summary`、`description`、tag 描述统一优先使用中文
- route 元数据必须就近声明在 route 文件中，不要在 Swagger/OpenAPI 服务层做兜底推断
- schema 必须定义在 `src/schemas/` 目录中，禁止在 route 文件中内联声明请求体、响应体或字段结构
- schema 字段描述必须与真实实现一致，不能为了文档展示虚构字段语义
- 如果接口属于内部使用、框架透传、静态资源、代理入口、MCP 服务入口、WebSocket/协议入口等不面向外部开发者的能力，也要补说明；需要隐藏时使用 `detail.hide: true`
- WebSocket / MCP / 代理入口如果无法被 OpenAPI 准确建模，优先补协议说明，不伪造 REST 风格响应结构

### API Key 安全策略

- `@better-auth/api-key` 插件管理，SHA-256 hash 存储，创建时返回明文（仅一次）
- 验证：`auth.api.verifyApiKey({ body: { key: token } })`
- Provider API Key 用 `{env:RCS_SECRET_<name>}` 占位符，密文存环境变量

### better-auth 服务端 API 调用约定

所有参数通过**单参数对象**传递，POST 业务数据嵌套在 `body` 中，需要 session 的 API 必须传 `headers: request.headers`。`listMembers` 返回 `{ members, total }`。`createApiKey` 的 `expiresIn` 单位是**秒**，内部自动转为天；默认最小 1 天 (86400 秒)

### Skills 存储路径

元数据在 PostgreSQL `skill` 表，Markdown 内容在文件系统 `{SKILL_DIR}/<name>/SKILL.md`（`SKILL_DIR` 环境变量，默认 `./data/skills`）

### Agent 模板存储路径

预设模板存放在 `.agents/agents/` 目录，每个文件为 **Markdown + YAML frontmatter** 格式（使用 `gray-matter` 库解析，禁止手写正则）。后端通过 `src/services/agent-templates.ts` 的 `loadAgentTemplates()` 加载，带进程级内存缓存。

**文件格式**：
```markdown
---
name: 模板名称
description: 模板描述
skills:
  - skill-name
---
正文内容作为 prompt...
```

**frontmatter 字段**：`name`（必填）、`description`（必填）、`skills`（可选，skill name 数组）
**文件名**：kebab-case，`.md` 扩展名，去掉扩展名即为模板 `id`

### Permission 权限系统

`permission` 三态：`"ask"` 询问、`"allow"` 允许、`"deny"` 拒绝。规则型工具（read/edit/bash 等）支持通配符规则，开关型工具（todowrite/question/webfetch 等）仅三态。

内置 Agent（不可删除）：`build`、`plan`、`general`、`explore`、`title`、`summary`、`compaction`

## 数据库

PostgreSQL + Drizzle ORM（`drizzle-orm/postgres-js`），Schema 在 `src/db/schema.ts`（唯一真相来源）。

表分类：better-auth 核心表（user/session/account/verification）、organization 插件（organization/member/invitation）、api-key 插件（apikey）、自定义表（mcpTool/scheduledTask/taskExecutionLog/shareLink/shareEventSnapshot/environment/agentSession）、配置表（provider/model/agentConfig/agentConfigSkill/mcpServer/skill/userConfig）、知识库（knowledgeBase/knowledgeResource/agentKnowledgeBinding）、Workflow（workflow/workflowVersion/workflowRun/workflowEvent/workflowSnapshot/workflowNodeOutput/workflowBoard/workflowJob/workflowTrigger）、IM 通道（imChannel/imChannelRoute/channelBinding）、Registry（machine/registryEvent）

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

路径 `src/__tests__/*.test.ts`。Mock 通过 `src/test-utils/setup-mocks.ts` 集中注册（`bunfig.toml` preload）。

**铁律**：
- **禁止在测试文件中调用 `mock.module()`**，统一使用 `src/test-utils/` 下的 stub 注册表
- 测试文件通过 `stubXxx()` 函数配置行为，`beforeEach` 先 `resetAllStubs()` 再配置

**测试分层**：L1 纯函数（无 mock）、L2 业务逻辑（stub）、L3 路由集成（stub + setTestAuth + setTestOrgContext）、前端关键流程

**编写规则**：每个测试独立、每个 test 上方一行中文注释、L3 不重复 L2 细节、前端只测关键流程

### 前端测试 (Bun test)

路径 `web/src/__tests__/`，React Testing Library + ReactDOMServer。文件路径用 `import.meta.dirname` 构建（不用相对路径字符串）。

注释规范：每个 `test(...)` 上方补一行中文注释。

**前端测试规则**：只测关键流程（表单提交、数据操作、导航路由、状态联动），不写类型检查测试和纯 UI 结构断言。Mock API 使用 `fetch` mock 或 MSW，不用 `mock.module()`。命名 `<功能>-flow.test.ts`。

### tsconfig

后端 extends `tsconfig.base.json`（workspace 路径别名），前端独立 `web/tsconfig.json`（`jsx: "react-jsx"`，`@/*` → `./*`）。

## 常见陷阱

违反会直接导致 bug，写代码前必须了解：

**架构约束**：

1. **配置写入竞争**：`src/services/config/` 下的配置写入逻辑无分布式锁，并发 upsert 可能竞态
2. **acp-link spawn 认证**：本地 WS 始终 auth，自动生成 64 位 hex token，relay 须从 stdout 正则捕获
3. **acp-link 端口残留**：服务器重启不会杀旧进程，需先清理否则 `EADDRINUSE`
4. **acp-link standalone 模式**：spawn 时不设 `ACP_RCS_URL`，opencode 子进程由 relay 连接触发
5. **relay 断连不杀进程**：前端断连只关 WS，不终止 acp-link
6. **keep_alive 不透传前端**：relay 层拦截，否则前端报错
7. **ACP vs RCS session ID**：ACP `ses_xxx` vs RCS `session_xxx`/`cse_xxx`，文件 API 须用 RCS ID（`resolveExistingSessionId`）
8. **requireOrgScope**：新增 organization 级资源路由必须调用
9. **`||` vs `??`**：允许空字符串的参数默认值必须用 `??`，`"" || fallback` 会丢失空字符串
10. **workspace 路径**：DB `workspace_path` 列已废弃，一律通过 `EnvironmentRecord.workspacePath`（已计算）使用
11. **字段废弃须全局 grep**：废弃 DB 字段时必须 grep 所有读取点逐一迁移
12. **服务端不传绝对路径给 plugin**：plugin 按 `orgId/userId/envId` 自行计算
13. **relay 必须转发 agent `status`**：前端依赖 `capabilities` 判断 ACP 能力
14. **Skill DB+文件系统双同步**：必须通过 `setSkill`/`importSkillDirectories` 创建，禁止直接调 `upsertSkill`
15. **JSON-RPC 请求 id 不可重复生成**：`createRequest()` 内部已调用 `nextRpcId()` 生成 id，外部不得再单独调 `nextRpcId()` 取 `reqId`，否则请求实际 id 与 handler 匹配的 id 差 1，导致 JSON-RPC 响应永远匹配不上。正确做法：`const req = createRequest(...); const reqId = req.id;`（见 `acp-transport.ts`）
16. **`@lobehub/icons` 不可被后端/纯逻辑测试间接加载**：该包依赖 `antd-style`，后者在模块加载时通过 `@emotion/cache` 调用 `document.querySelectorAll` 创建样式缓存，在 happy-dom 测试环境中会崩溃（`window.SyntaxError` 未定义）。**约束**：含 `@lobehub/icons` import 的组件文件不得导出纯工具函数供测试使用——纯逻辑须提取到不依赖 UI 的独立模块（参考 `web/src/pages/agent-panel/pages/agent-models-utils.ts` 从 `AgentModelsPage.tsx` 拆出 provider 工具函数的先例）。`mock.module("antd-style")` 无法彻底解决，因 `@lobehub/icons` 从 `antd-style` 按需导入 `keyframes`/`createStaticStyles`/`cssVar` 等命名导出，枚举不全仍会报 `Export named 'xxx' not found`

**API/路由**：文件 API 用 `/web/sessions/:id/user/*`（不是 `/files/*`）；API 改造保留旧字段直到前端迁移；Workflow 节点 inputs 引用须在 `depends_on` 节点中存在

**前端**：修改后必须 `bun run build:web`；WebSocket timeout > 30s；FilePickerDialog 上传始终到 `user/`；`routeTree.gen.ts` 严禁手动编辑；TanStack Router Vite 插件必须在 `plugins` 数组第一位；Sidebar 导航项必须有 `to` 字段

## 后端开发约束

1. 数据库操作尽量内聚到对应的 service 文件中，并通过函数统一暴露给其他 service 使用；避免把同一类数据访问逻辑分散到多个地方。
2. API 需要默认保证向后兼容；新增字段优先兼容旧客户端，删除或修改旧字段语义前必须评估影响；如果新功能难以兼容旧行为，应新增新版本 API，而不是直接破坏原有接口。

## 代码风格

### 代码注释

1. AI 编写或修改代码时，**默认要主动补齐必要注释**，不要因为“代码能运行”就省略说明。
2. 注释优先说明设计原因、边界条件、隐藏前提、兼容性约束和临时性取舍，不解释显而易见的语句行为。
3. 对较长函数，**必须**在函数内部按处理阶段添加简短注释说明，每个主要阶段都要有对应注释，帮助读者快速理解结构；不要把整段复杂流程裸露给后续维护者。
4. 对复杂逻辑、非直观控制流、特殊框架约束、兼容性处理或“看起来可以更简单却没有那么做”的代码，必须补充简洁注释说明原因。
5. 临时性方案必须注明临时原因、适用范围和后续清理条件，避免后续误以为这是长期设计。
6. 如果新增分支、状态机、数据转换、权限判断、兜底逻辑或协议适配逻辑，默认检查是否需要补一条注释；拿不准时，宁可补一条简短高质量注释，也不要完全不写。

### 文档注释

1. 文档注释是**强制要求**：类、公共函数、公共方法、导出工具和类型定义**必须**提供清晰简洁的文档注释；尤其是类定义头部和公共函数声明，禁止缺失。
2. 对职责不直观、边界条件较多、被多处复用或名称不足以自解释的内部辅助函数，也**必须**补充必要的文档注释，不能因为它“不是导出的”就省略。
3. 文档注释至少应说明“这个东西负责什么”；必要时必须补充关键输入、输出、副作用、约束、异常情况或调用前提。

### 日志输出

1. AI 编写或修改涉及业务流程、状态变化、外部调用、异常处理的代码时，**默认要主动补齐必要日志**，不要只在报错时随手打印一句。
2. 在关键输入输出、错误处理、进入兜底逻辑、兼容性分支、重试、降级、跳过、提前返回和状态迁移时，应补充合适的日志输出，确保问题可追踪。
3. 日志应优先记录关键上下文、分支原因、对象标识、结果状态和影响范围，避免只输出空泛文本，如“start”“failed”“done”。
4. 错误日志应包含足够的定位信息；进入临时兼容或降级路径时，应明确说明触发原因和影响范围。
5. 如果一段新逻辑在出问题后只能靠猜测排查，说明日志不够；提交前应主动补到“能让后来者复盘发生了什么”为止。

### Biome（lint + format）

Biome v2.4.15，space indent 2，lineWidth 120。`noExplicitAny: warn`，`noNonNullAssertion: off`，`useConst: error`。测试目录宽松处理。

#### biome-ignore 使用规范

- **禁止对 biome-ignore 行做 `--write` 自动修复**：会误删 suppression 注释，连带破坏类型断言
- **precheck 的 `--write` 只用于格式化和 import 排序**（`--linter-enabled=false`）
- biome 报 `suppressions/unused` warning 时，确认代码仍需该 suppression 后保留

### TypeScript 类型规范

- **Zod v4**：项目使用 Zod v4，导入路径 `from "zod/v4"`（不是 `from "zod"`）。禁止使用 v3 API
- **禁止 `as any`**（业务代码），用具体类型或 `as unknown as TargetType` 双重断言
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

- **后端**：`src/routes/`（按功能分组：`v2/`、`web/`、`acp/`、`mcp/`，另有 `hooks.ts`；其中 `v2/` 同时承载 `/v1/code/sessions/*` 与 `/v2/session_ingress/*`）、`src/services/`（业务逻辑）、`src/services/config/`（配置 CRUD）、`src/schemas/`（请求验证 schema）、`src/repositories/`（数据访问层）、`src/plugins/`（Elysia 插件）、`src/transport/`（WebSocket/传输）、`src/auth/`（认证）、`src/db/`（Drizzle schema）、`src/__tests__/`
- **前端**：`web/src/routes/`（TanStack Router）、`web/components/`（通用组件，`@/components` alias）、`web/src/pages/`（页面组件）、`web/src/api/`（API 客户端）、`web/src/acp/`（ACP 协议客户端）、`web/src/__tests__/`

### Git 提交风格

Angular 风格（`feat:` / `fix:` / `refactor:` / `test:` / `chore:` / `docs:`），中文标题。每个提交单一职责，作用域用括号（如 `feat(workflow):`）。AI 辅助提交必须附加 `Co-authored-by`（Claude / GLM / GPT / Gemini）。大分支合并前 squash merge

**提交前必须 precheck**：每次 `git commit` 前，如果本次有代码改动（非纯文档/配置），必须先运行 `bun run precheck` 确保通过后再提交。precheck 会自动修复格式和 import 排序，修复后的变更一并提交

### React 组件模式

1. `useState` + `useCallback`，避免依赖循环
2. 导航用 `<Link>` 或 `useNavigate()`，禁止 `window.history.pushState`
3. 路由参数：`Route.useParams()`，search params：`Route.useSearch()`
4. 表单：react-hook-form + zod（`FormDialog` 已封装）
5. 异步操作：try-catch + toast + finally 清理 loading
6. 新增页面：`web/src/routes/agent/_panel/` 下创建路由文件，lazy import

### 错误处理

- **前端**：`toast.error()` 显示错误（sonner）
- **后端**：`{ error: { type, message } }` 格式
- **环境变量校验**：`src/env.ts` 的 `validateEnv()`，测试环境抛 Error，生产 `process.exit(1)`
