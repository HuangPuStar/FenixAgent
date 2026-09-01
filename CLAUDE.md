# CLAUDE.md

## 核心工程原则

1. **架构与领域优先**：计划阶段应以理想架构为目标，明确业务目标、领域边界、模块职责、依赖方向和数据流，形成符合领域规律、面向长期维护且可持续演进的设计后再进入编码；不得以短期实现便利牺牲整体设计。设计必须完整，实现应当克制：不做推测性抽象，抽象延迟到第二个真实用例出现时才引入，单一场景直接实现。
2. **追求优雅的代码模块**：模块应高内聚、低耦合，通过精简且稳定的接口封装内部复杂度，使职责、命名、依赖和扩展方式清晰自然；代码按单一职责拆分，单个文件不得超过 500 行，接近上限时应优先重构模块边界。
3. **保持边界与数据流清晰**：协议模型、领域模型、持久化模型和视图模型不得相互泄漏；数据必须在边界处完成校验和独立转换，避免跨层共享可变状态。
4. **安全与隔离默认开启**：所有功能均按多租户、多用户场景设计，明确认证、授权和数据隔离边界；遵循最小权限原则，任何外部输入均视为不可信，敏感信息不得进入代码、日志或响应。
5. **面向并发与故障设计**：后端应主动考虑幂等性、竞态、事务边界、超时、取消、重试、背压和资源释放；不得通过无边界重试、吞错或隐式共享状态掩盖问题。
6. **保障完整前端体验**：前端应控制渲染成本、异步状态和并发请求，保持清晰的 UI 结构；用户流程必须覆盖加载、空状态、错误、重试、反馈和可访问性。
7. **复用稳定的业务语义**：优先复用已有模块和能力，但不要仅因代码外形相似而过早抽象；确需重复时，必须注释说明其独立演进或暂不抽象的原因。新增依赖前先核查项目已有依赖（根 `package.json` 与 `packages/` workspace）能否满足需求，不得臆断已有库缺少功能——先查阅文档和类型定义；确需引入时优先成熟且维护良好的库，不重复实现通用功能。
8. **为未来维护者保留上下文**：代码、注释、测试和架构文档是跨越时间的协作媒介。非显然的设计决策、兼容约束、已知缺陷和临时方案，必须记录原因、影响范围、潜在风险及移除条件；技术债务应关联可追踪任务，关键架构决策应同步到 ADR，禁止留下缺少上下文的 `TODO`。
9. **确保变更可验证、可观测、可回滚**：每项改动都应行为可测试、运行状态可观测、故障可定位，并兼顾向后兼容和回滚路径；错误与日志必须保留诊断上下文，但不得泄露敏感信息。
10. **删除优于兼容**：内部路径重构时直接删除过时实现，禁止新增兼容层、deprecated shim 或双写逻辑；对外契约（`/api/*` 等稳定接口、数据库迁移）的兼容性按协议契约单独评估，属于合同义务而非迁就旧代码。

> **变更速查**：提交前运行 `bun run precheck`；修改前端后额外运行 `bun run build:web`；修改 schema 后运行 `bun run db:generate --name <name>` 和 `bun run db:migrate`。

## 文档使用与规范入口

- 前端开发规范：`docs/developer/guide/frontend-development.md`
  - 覆盖目录结构、路由、状态管理、组件、API、i18n、样式和安全规范。
- 后端开发规范：`docs/developer/guide/backend-development.md`
  - 覆盖目录分层、数据库、API、注释、日志和架构文档规范。
- 架构说明：`docs/arch/`；设计方案：`docs/design/`；关键且长期有效的架构决策应记录为 ADR（`docs/adr/` 不存在时，在实际产生首个 ADR 时再创建）。
- 本文件只维护跨模块工程原则、关键工作流、架构契约和项目特有不变量，具体实现细则应下沉到离代码更近的规范。
- 规则冲突时，以离代码更近、约束更具体且与当前实现一致的文档为准；若文档与代码不一致，先核实设计意图并同步修正文档，不得静默沿用冲突规则。

## 项目与架构地图

FenixAgent 是基于 Elysia + Bun 的多租户 ACP Agent 平台，前端使用 React 19 + Vite，数据层使用 PostgreSQL + Drizzle ORM。

- 主要能力：组织与多租户、Agent 配置、ACP 实时通信、工作流、知识库、定时任务和 IM 通道。
- 根目录 `package.json` 是前后端统一依赖清单；`web/` 没有独立 `package.json`。
- `packages/` 是 Bun workspace，当前包含 11 个内部包；跨包能力应通过包导出的稳定接口复用，不得依赖包内实现细节。

### 后端地图

- `src/index.ts`：服务入口和装配层。
- `src/routes/web/`：控制台内部 API。
- `src/routes/api/`：对外稳定 API / OpenAPI。
- `src/routes/acp/`、`src/routes/mcp/`、`src/routes/hooks.ts`：内部协议和 Webhook 入口。
- `src/services/`：领域规则、业务编排、事务边界和外部能力调用。
- `src/repositories/`：数据访问层。
- `src/schemas/`：请求、响应和配置 schema。
- `src/transport/`：WebSocket、SSE、relay 和 EventBus。
- `src/db/schema.ts`：数据库 schema 真相来源。
- `src/__tests__/`、`src/test-utils/`：后端测试和测试基础设施。

### 前端地图

- `web/src/routes/`：TanStack Router 文件路由；Agent 面板页面位于 `web/src/routes/agent/_panel/`；`routeTree.gen.ts` 为生成文件，严禁手改。
- `web/src/pages/`：页面和业务容器。
- `web/components/`：通用 UI 与业务组件。
- `web/src/api/`：前端 API 建模层。
- `web/src/acp/`：ACP 客户端。
- `web/src/i18n/`：国际化配置与语言资源。
- `web/src/__tests__/`：前端关键流程测试。

## 开发工作流

### 计划阶段

进入编码前必须：

1. 确认需求、领域术语、模块边界、数据流和向后兼容要求。
2. 查找已有实现、公共接口和相邻模块，优先深化现有模块，不并行创建第二套能力。
3. 明确多租户隔离、权限校验、并发与失败路径。
4. 定义验证方式、可观测信号和回滚路径。
5. 涉及长期架构决策时同步规划 `docs/arch/`、`docs/design/` 或 ADR 更新。
6. 大功能按可运行的垂直切片分阶段交付：每层从最小端到端版本起步，保持可测试、可观测、可回滚，不一次性铺完整层再联调。

### 常用命令

```bash
bun run dev                         # 后端开发
bun run dev:web                     # 前端开发
bun run build:web                   # 前端生产构建
bun run docs:dev                    # 文档开发
bun run docs:build                  # 文档构建
bun run precheck                    # format、import-sort、architecture、server/web tsc、lint、后端测试
bun run db:generate --name <name>   # 生成 Drizzle 迁移
bun run db:migrate                  # 执行迁移
```

### 按变更类型验证

- 后端改动：运行相关 `bun test src/__tests__/<file>.test.ts`，完成后运行 `bun run precheck`。
- 前端改动：运行相关 `bun test web/src/__tests__/<file>.test.ts` 和 `bun run build:web`，完成后运行 `bun run precheck`；生产构建不可省略，因为后端从 `web/dist/` 挂载静态资源。
- 数据库改动：生成并审查迁移，执行 `bun run db:migrate`，再运行相关测试和 `bun run precheck`。
- 文档站点改动：运行 `bun run docs:build`。
- `precheck` 必须全绿才能提交；它目前只运行 `src/__tests__/`，不能替代前端测试和前端生产构建。

## 架构边界与模块契约

### 后端分层

默认依赖方向：`routes -> services -> repositories -> db`，`services -> packages/*`，`routes -> schemas`。

- route 只负责协议接入、鉴权、参数校验和响应映射，不得直接访问 `db`。
- service 负责领域规则、业务编排、事务边界、跨表操作和外部调用。
- repository 只负责持久化和查询条件封装，不承载业务规则。
- 新增数据库操作应收敛到 repository；历史 service 直连 DB 的写法不得继续扩散。
- 禁止反向依赖和跨层复用内部实现，例如 repository 调用 service/route，或一个 route 导入另一个 route 的业务逻辑。
- schema 放在 `src/schemas/`，复杂请求/响应结构不得内联在 route 中。

### API 与数据模型边界

- `/web/*` 服务控制台前端，默认响应 `{ success, data }` 或 `{ success: false, error }`。
- `/api/*` 服务外部系统和 API Key 调用方，优先保证向后兼容。
- ACP、MCP、hooks、skills 等内部协议能力使用独立前缀，不得混入 `/web` 或 `/api`。
- 新接口默认补齐 OpenAPI 的 `detail`、`params`、`query`、`headers`、`body` 和 `response`。
- 协议 DTO、领域对象、数据库记录和前端 ViewModel 在边界处独立转换；前端类型必须对应后端真实返回，禁止增加“幻影字段”。
- 前端 URL 统一使用 `/web/*`，不得新增历史 `/v1`、`/v2` 前缀。
- `POST /web/config/:module` 保持既有 action 风格；同一路由文件可能混用 RESTful 与 action 风格，修改前必须核对实际协议，不得擅自统一。

### 前端边界与体验

- 导航只使用 `<Link to>`、`useNavigate()` 和 `router.invalidate()`；禁止 `window.location.href`、`window.location.replace`、`window.location.reload` 和 `window.history.pushState`。Sidebar 导航项必须提供 `to`。
- 请求统一通过 `web/src/api/request.ts`；`request<T>()` 已处理路径参数、query、JSON、错误标准化和响应解包。
- 数据获取优先遵循前端规范和现有 `ahooks` / `useRequest` 模式，避免重复请求与竞态覆盖。
- 用户可见字符串必须通过 `t()`；i18n 插值使用 `{{var}}`，单花括号 `{var}` 会被当作字面文本。
- 基础组件优先复用 `web/components/ui/`；通用图标使用 `lucide-react`；模型品牌图标使用 `web/components/model-icon/ModelIcon.tsx`。
- 纯逻辑模块不得依赖 UI 图标包；特别是不得让后端或纯逻辑测试间接加载 `@lobehub/icons`。
- 页面流程必须覆盖 loading、empty、error、retry、success feedback 和可访问性状态。
- 路径别名：`@/src` → `web/src`，`@/components` → `web/components`，`@server` → `../src`。

### Agent 通信权威路径

Agent 通信分为三种明确场景，底层 relay 与 ACP 消息规则必须复用，不得再创建独立 JSON-RPC 协议栈。

| 场景 | 权威实现 | 生命周期 |
|------|----------|----------|
| HTTP / 程序化单轮调用 | `src/routes/api/openai-chat.ts` → `src/services/agent-chat-service.ts` | route 调用 `openAgentSession`；service 执行 `createAgentSession` → `startPromptTurn`，每次创建独立实例并在 dispose 时销毁 |
| Workflow | `src/services/workflow/agent-chat-transport.ts` | 通过 `ensureRunning`、`connectAgentRelay` 复用实例，再适配 `agent-chat-service` 的 `PromptTurn` |
| 前端交互式 Chat | `packages/chat-channel/src/channel/`（宿主装配 `src/services/chat-channel-bootstrap.ts`） | 使用共享 relay、Y.Doc 状态和独立 session 生命周期；复用 `connectAgentRelay` 与 `@fenix/chat-channel` translator |

- relay JSON-RPC 必须兼容原始 `{ jsonrpc: "2.0", ... }` 和包裹 `{ type, payload: { jsonrpc: "2.0", ... } }` 两种格式，统一使用现有 `extractJsonRpc()` 模式。
- `session/update` 的事件类型位于 `params.update.sessionUpdate`，事件载荷位于同一 `update` 对象，文本内容通常在 `update.content`；禁止读取不存在的 `update.agent_message_chunk` 或把 `sessionUpdate` 当作文本。
- 实例策略不可混用：Workflow / 交互式路径通过 `ensureRunning(...)` 复用实例；`openAgentSession` 通过 `spawnInstanceViaController(...)`（`src/services/orchestration-instance.ts`）创建独立实例并负责销毁。
- 不得恢复已删除的独立 `acp-transport.ts` 或在新入口中复制 session/new、session/load、session/prompt 的完整协议流程。

## 领域不变量与高风险约束

### 认证、组织与密钥

- 普通 HTTP / WebSocket 请求先尝试 better-auth session cookie；无 session 时依次尝试 Environment Secret 和 better-auth API Key。
- 系统 API 使用独立的 `RCS_SYSTEM_API_KEYS`；`RCS_API_KEYS` 当前用于 skill 下载 token 的 HMAC 签名，不得混作普通请求认证规则。
- active organization 提取优先级：`x-active-org-id` header → `activeOrganizationId` query → `active_org_id` cookie。
- API Key 的组织上下文必须由 key metadata 恢复并重新校验成员关系；校验异常时保守拒绝。
- 测试可使用 `setTestAuth()`、`setTestOrgContext()` 注入上下文，测试结束必须 reset，避免状态泄漏。
- 密钥、token、密码和连接串不得写入源码、fixture、日志或错误响应。

### Workspace 与远程文件

- workspace 路径运行时通过 `resolveWorkspacePath(organizationId, userId, environmentId)` 计算：`{WORKSPACE_ROOT}/{organizationId}/{userId}/{environmentId}`。
- DB `workspacePath` 是历史字段，不得用于推导真实目录。
- 浏览器传入的 workspace/cwd 不可信；ACP action 的 `cwd` 必须由服务端根据已认证 environment 注入。
- 文件 API 使用 RCS session/environment 上下文，不得把 ACP `ses_*` 当作 RCS 标识。
- `getRemoteMachineId` 优先读取 agent config 的 `machineId`，否则 fallback 到 `RCS_DEFAULT_MACHINE_ID`；无 `agentConfigId` 的 ACP/Bridge environment 同样必须执行 fallback。
- 配置了远程 machine 但 file-ws 未连接时必须返回明确错误，不得静默回退到本地 FS，避免远程/本地文件分裂。
- 文件 API 路径为 workspace 根相对路径，必须经过词法校验（绝对路径 / `..` / 控制字符）与 realpath 越界检查（symlink 逃逸防护）。

### Skill、Agent 模板与 Permission

- Skill 是 PostgreSQL 元数据、源目录和归档文件的组合存储；创建或导入必须通过 `setSkill` / `importSkillDirectories` 完成完整编排。
- 直接调用底层 `upsertSkill` 只更新元数据，不能替代文件写入、归档和失败回滚。
- Agent 模板位于 `.agents/agents/`，格式为 Markdown + YAML frontmatter，解析必须使用 `gray-matter`，不得手写正则。
- Permission action 只有 `ask` / `allow` / `deny`；规则型工具支持全局三态或 glob pattern 映射，开关型工具只支持三态字符串。

### ACP / Runtime

- `acp-link` 本地 WebSocket 始终需要认证，relay token 由启动流程从 stdout 获取，不得硬编码或记录。
- 服务重启不会自动清理旧 `acp-link` 进程；排查 `EADDRINUSE` 时先确认残留进程和端口归属。
- relay 断连只关闭连接，不等于终止 Agent 子进程；实例释放必须走对应生命周期管理。
- relay 必须传递 Agent `status`，前端依赖 `status.capabilities` 决定可用能力。
- ID 体系不可混用：ACP session ID 为 `ses_*`；RCS session ID 由 `createDeterministicRcsSessionId(agentId, userId[, sessionId])` 生成，格式为 `rcs_*`。多实例场景下应传入 DB 会话 ID（`sessionId`）以实现 YJS doc 隔离。

### YJS / Chat

以下约束共同保证刷新恢复、多标签页一致性和消息不重复：

1. `rcsSessionId` 必须确定性生成，不得使用 `Date.now()` 或随机值，否则刷新后旧 Y.Doc 不可达。
2. WebSocket open 时必须在 `relayReady = true` 前发送 Chat Doc 和 Session Doc 初始快照。
3. 重连时必须从 `chatMeta.activeSessionId` 恢复 `entry.acpSessionId`；同一 ACP session 的 `load_session` 必须跳过 Agent 全量回放。
4. `session/list`、`session/new`、`session/load` 和 `session/resume` 的 `cwd` 必须由服务端 translator 注入；Agent status 到达前不得发送 `list_sessions`。
5. Y.Doc 名称使用 `chat:{rcsSessionId}` / `session:{rcsSessionId}`，广播必须按 `rcsSessionId` 隔离，禁止全局广播会话数据。
6. 用户消息只由后端写入 Y.Doc；前端不得维护第二份 `localUserEntries`，否则 Agent 回显会造成双写。
7. 清理会话内容使用 `clearSessionDocContent` 在原 Y.Doc 事务中完成；禁止通过 destroy + recreate 制造异步竞态。`create_session` 同样必须先清空旧 Session Doc。
8. 同一 `instanceId + userId` 的多标签页共享一个 relay handle；引用计数归零后才释放，切换 session 时同步同组客户端的 `acpSessionId`。
9. WebSocket 发送背压阈值为 64 KB，默认连接上限为 200（`YJS_MAX_CLIENTS`）；修改时必须保留限流、资源释放和单连接故障隔离。
10. `ChatView` 与 `EntryRenderer` 使用 `React.memo`；comparator 必须与调用方 prop 稳定性保持一致，修改 props 时同步更新 comparator 和相关渲染测试。
11. `@fenix/chat-channel` 根入口必须浏览器安全：只导出类型、schema、`chat-writer`、`yjs-store`、`protocol`、`transport`、`util`；服务端能力（`channel` 控制面、`persist` 持久化、`state` 聚合层 DocManager/factory/aggregator 等）必须经 `@fenix/chat-channel/server` 子路径导出。前端 vite alias 直连根入口，从根入口 re-export 服务端模块会把 node 依赖打进浏览器 bundle（2026-08-17 事故：`node:crypto` 外置桩致整包加载崩溃）；边界由 `src/__tests__/chat-channel-browser-surface.test.ts` 静态走值导入图守护。

## 数据库与迁移

- Schema 真相来源是 `src/db/schema.ts`。
- 标准流程：修改 schema → `bun run db:generate --name <name>` → 审查 `drizzle/*.sql` 与 `drizzle/meta/*` → `bun run db:migrate` → 运行相关测试和 `bun run precheck`。
- 提交迁移时必须提交完整 `drizzle/` 迁移链，不能遗漏 `drizzle/meta/*`。
- 禁止手写 SQL 迁移绕过 Drizzle，禁止在生产环境使用 `db:push`。
- 迁移设计必须考虑已有数据、锁范围、回滚或补偿策略，以及多实例并发启动时的幂等性。
- 生产迁移入口为 `scripts/migrate.ts` 构建出的 `migrate.js`。

## 质量、测试与长期维护

### 测试

- 后端测试位于 `src/__tests__/`，前端测试位于 `web/src/__tests__/`。
- 优先复用 `src/test-utils/`，测试文件禁止直接调用 `mock.module()`。
- 每个 `test(...)` 上方添加一行中文注释，说明行为和业务意图。
- 前端只测试关键交互、状态和数据流，不编写纯 UI 结构断言或仅重复类型检查的测试。
- 并发、重连、权限、租户隔离、迁移和失败回滚必须覆盖关键边界测试。

### 代码与注释

- TypeScript 业务代码禁止 `as any`；确因第三方类型缺陷需要规避时，使用最小范围的类型收窄或带原因的行级 ignore。
- Zod 使用 `zod/v4`。
- 允许空字符串的默认值使用 `??`，不得使用会吞掉空字符串的 `||`。
- `catch` 必须保留诊断上下文，不得吞错；对外错误不得泄露敏感信息或内部实现。
- 公共函数、公共方法、导出工具和类型定义应有清晰文档注释。
- 注释解释设计原因、边界条件、兼容约束、风险和临时取舍，不重复代码表面行为。
- 已知缺陷或临时方案必须记录影响范围、风险、移除条件和可追踪任务；关键架构选择同步到架构文档或 ADR。

### 命名与 Git

- 文件使用 kebab-case，组件使用 PascalCase，函数使用 camelCase，常量使用 UPPER_SNAKE_CASE。
- 提交信息使用 Angular 风格：`feat:` / `fix:` / `refactor:` / `test:` / `chore:` / `docs:`，标题使用中文。
- 未经明确要求不得创建 commit；代码改动提交前必须运行 `bun run precheck`，前端改动还必须运行 `bun run build:web`。

### 质量红线

- 不得新增 typecheck、lint 或测试错误；linter warning 也必须清零（info 除外）。
- `precheck` 报错必须处理后才能宣称完成；若失败来自与当前改动无关且无法安全修复的工作区状态，应明确报告证据和影响，不得以“历史问题”为由宣称检查通过。
- 自动修复工具只能用于已审查范围；不得为了通过检查而无边界改写无关文件。
- 每条变更都应能追溯到需求、架构约束、缺陷修复或必要验证，禁止顺手重构无关代码。

## 环境变量

环境变量的类型、默认值和必填性以 `src/env.ts` 为准；新增变量必须同步 schema、部署配置和相关文档。`YJS_MAX_CLIENTS` 是 YJS transport 中直接读取的兼容变量；`RCS_YJS_SNAPSHOT_*` 三项在 `src/env.ts` 声明校验、由 `packages/chat-channel` 持久层直读（provider 收敛到宿主 DI 后应改为经 options 注入）。关键变量：

- 必填：`DATABASE_URL`、`RCS_API_KEYS`。
- 系统 API：`RCS_SYSTEM_API_KEYS`。
- 存储与密钥引用：`SKILL_DIR`（默认 `./data/skills`）、`WORKSPACE_ROOT`（默认运行目录下的 `workspaces`）、`RCS_REDIS_URL`；provider 等配置通过 `{env:RCS_SECRET_<name>}` 引用环境密钥。
- 系统管理：`RCS_SYSTEM_ADMIN_PASSWORD_FILE`（默认 `./data/password.txt`）。
- Agent 路由：`RCS_DEFAULT_MACHINE_ID`、`RCS_DEFAULT_ENGINE_TYPE`、`RCS_DISABLE_LOCAL_EXECUTION`。
- 观测透传：`LANGFUSE_PUBLIC_KEY`、`LANGFUSE_SECRET_KEY`、`LANGFUSE_BASE_URL` 由主服务声明，经 `launchSpec.env` 统一透传到 machine 上 agent 进程（peri 的 langfuse-client 直读同名变量）；未设置则不注入，`extraEnv` 同名变量仍优先。动态 user 维度：`LANGFUSE_USER_ID` 由 `buildAgentLaunchSpecForCore` 的 platformEnv 按实例注入（与 `USER_META_USER_ID` 同源：environment 属主优先，fallback 到实例用户），peri 的 langfuse tracer 写入 `TraceBody.user_id`。
- 并发与生命周期：`RCS_ENVIRONMENT_MAX_SESSIONS`（新建 Environment 的默认 Instance 并发上限，默认 5）、`RCS_AGENT_MAX_CONCURRENCY`、`RCS_USER_AGENT_MAX_CONCURRENCY`、`RCS_SCHEDULED_AGENT_MAX_CONCURRENCY`、`RCS_ACP_IDLE_TIMEOUT_SECONDS`、`RCS_ACP_IDLE_SWEEP_INTERVAL_SECONDS`、`RCS_ACP_ACTIVITY_TIMEOUT_SECONDS`。
- YJS：`YJS_MAX_CLIENTS`（代码默认 200）；快照持久化：`RCS_YJS_SNAPSHOT_INTERVAL_MS`（节流窗口，默认 2000）、`RCS_YJS_SNAPSHOT_IDLE_MS`（静默期，默认 500）、`RCS_YJS_SNAPSHOT_TTL_SECONDS`（快照滑动 TTL，默认 7 天）。
