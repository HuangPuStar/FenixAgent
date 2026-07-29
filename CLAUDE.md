# CLAUDE.md

## 核心工程原则

1. **架构与领域优先**：计划阶段应以理想架构为目标，明确业务目标、领域边界、模块职责、依赖方向和数据流，形成符合领域规律、面向长期维护且可持续演进的设计后再进入编码；不得以短期实现便利牺牲整体设计。
2. **追求优雅的代码模块**：模块应高内聚、低耦合，通过精简且稳定的接口封装内部复杂度，使职责、命名、依赖和扩展方式清晰自然；代码按单一职责拆分，单个文件不得超过 500 行，接近上限时应优先重构模块边界。
3. **保持边界与数据流清晰**：协议模型、领域模型、持久化模型和视图模型不得相互泄漏；数据必须在边界处完成校验和独立转换，避免跨层共享可变状态。
4. **安全与隔离默认开启**：所有功能均按多租户、多用户场景设计，明确认证、授权和数据隔离边界；遵循最小权限原则，任何外部输入均视为不可信，敏感信息不得进入代码、日志或响应。
5. **面向并发与故障设计**：后端应主动考虑幂等性、竞态、事务边界、超时、取消、重试、背压和资源释放；不得通过无边界重试、吞错或隐式共享状态掩盖问题。
6. **保障完整前端体验**：前端应控制渲染成本、异步状态和并发请求，保持清晰的 UI 结构；用户流程必须覆盖加载、空状态、错误、重试、反馈和可访问性。
7. **复用稳定的业务语义**：优先复用已有模块和能力，但不要仅因代码外形相似而过早抽象；确需重复时，必须注释说明其独立演进或暂不抽象的原因。
8. **为未来维护者保留上下文**：代码、注释、测试和架构文档是跨越时间的协作媒介。非显然的设计决策、兼容约束、已知缺陷和临时方案，必须记录原因、影响范围、潜在风险及移除条件；技术债务应关联可追踪任务，关键架构决策应同步到 ADR，禁止留下缺少上下文的 `TODO`。
9. **确保变更可验证、可观测、可回滚**：每项改动都应行为可测试、运行状态可观测、故障可定位，并兼顾向后兼容和回滚路径；错误与日志必须保留诊断上下文，但不得泄露敏感信息。


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

## 后端速查

- 分层默认遵循：`routes -> services -> repositories -> db`
- route 只做协议接入、鉴权、参数校验、响应映射
- service 负责业务编排、事务边界、跨表操作、外部调用
- repository 只做数据访问，不承载业务规则
- 数据库读写、查询条件拼装等 DB 操作默认收敛到 `repositories` 方便复用；`routes` 层一定不能直接访问 `db`
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
7. **`getRemoteMachineId` 允许无 `agentConfigId` 的 environment**：ACP/Bridge 注册路径（`registerEnvironment`、`createTemporaryEnvironment`）创建的环境没有 `agentConfigId`。`getRemoteMachineId` 不能对这类环境直接返回 null——必须先查 `agentConfigId`，不存在则 fallback 到 `config.defaultMachineId`，否则设了 `RCS_DEFAULT_MACHINE_ID` 文件操作也会落到本地 FS。

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

### YJS / Chat

1. **`rcsSessionId` 必须确定性生成**。使用 `agentId+userId` 拼接而非 `Date.now()` 随机值。页面刷新后同一用户同一 agent 复用相同 ID，Session Doc 在内存中持久存在。随机 ID 会导致旧 Doc 不可达、工具调用/流式状态全丢。
2. **Session Doc 初始快照必须在 `handleYjsWsOpen` 时推送**。重连客户端只收到 Chat Doc 快照，若不同步推送 Session Doc 快照，消息区域为空直到 agent 回放。与 Chat Doc 快照一并在 `entry.relayReady=true` 之前发送。
3. **重连后 `entry.acpSessionId` 必须从 Chat Doc 恢复**。新建 entry 时 `acpSessionId` 初始为 `null`，若不从 `chatMeta.activeSessionId` 恢复，后续 `load_session` 的 `isSameSession` 检查（`null === ses_xxx`）必定为 false → 误清 Session Doc → 多窗口工具调用消失。
4. **同 session 的 `load_session` 必须 skip agent 回放**。`isSameSession=true` 时直接 `return`，不向 agent 发送 `session/load` RPC。否则 agent 全量回放消息 → `processACP` 追加到 Session Doc → 其他在线客户端收到重复消息。
5. **`session/list` 必须注入 `cwd`**。YJS 前端没有旧 relay 的二次注入逻辑，必须在 `translateSimpleAction` 阶段就带 `cwd`，否则不同 environment 的会话列表会串数据。
6. **ID 体系不可混**：ACP session id 是 `ses_xxx`，RCS session id 是 `rcs_xxx`。文件 API 用 RCS id，ACP JSON-RPC 用 ACP ses_ id。
7. **Y.Doc 广播按 `rcsSessionId` 隔离，不发全局**。docName 格式 `chat:{rcsSessionId}` / `session:{rcsSessionId}`，`registerYjsDocListener` 从 docName 提取目标 ID 只发匹配客户端。
8. **用户消息只由后端写入 Y.Doc**。前端不维护 `localUserEntries`。Agent 回显会导致双写。
9. **Session Doc 清洁用 `clearSessionDocContent`（Y.Doc 事务内清空）而非 `closeSession`+`openSession`（destroy+recreate）**。`handleYjsWsMessage` 是 fire-and-forget async，destroy→recreate 间隙 agent 回放事件可写入错误 Doc。原地清空无竞态、不重注册 listener。
10. **`create_session` 也清空 Session Doc**。新建会话时旧消息若不清理，新旧 ACP session 消息叠加导致 chat 越来越长。
11. **Agent status 到达前不发 `list_sessions`**，否则收到空列表。
12. **Instance 级别 relay handle 共享**。同一 Agent 多标签页共享一个 relay handle，断开计数归零才销毁。
13. **WS 背压与连接防护**：`sendToYjsWs` bufferedAmount > 64KB 跳过；连接数上限 200（`YJS_MAX_CLIENTS`）。
14. **ChatView 用 `React.memo`**，comparator 排除 `onPermissionRespond`（始终新引用）。`EntryRenderer` 同步加 memo。

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

### 代码质量红线

**precheck 必须全绿才能提交。** `bun run precheck` 分为 6 个子步骤：format → import-sort → tsc (server) → tsc (web) → lint → test，任一步骤失败即为不通过。

- **禁止以"预存问题"为由跳过修复**：precheck 报出的 lint/typecheck 错误须在提交前清理。若错误确实不在本次改动范围内（如其他文件的历史遗留），仍需尽量修复——`biome --write --unsafe` 可秒修绝大多数 FIXABLE 问题。
- **禁止新增任何 typecheck 错误**：写新代码或修改接口后，确保 `tsc` 两个目标均 0 error。
- **禁止新增任何 lint 错误**：linter 的 error 和 warning 都必须清零（info 级别除外）。若引入的 warning 是误报（如 Elysia 路由 handler 的 `noExplicitAny`），需在行级添加 `// biome-ignore` 注释说明原因。

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
