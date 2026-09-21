# CE 阶段 2：整体架构适配

实施从[CE / EE 工程架构设计索引](./ce-ee-engineering-architecture.md)进入全部权威设计，结合执行时的真实源码、依赖、测试、迁移和部署状态，完成任务拆解、执行、复审、验证与收口。

实施必须持续到仓库满足设计文档中的全部架构约束与一致性验收标准；发现设计矛盾、缺失或需要改变公共合同、稳定协议、数据语义时停止对应分支，先由用户评审并修订权威设计，再继续实施。

## 1. 需要改动的范围

以下清单是阶段 2 的适配范围，用于避免遗漏；实施方式由执行时的真实情况决定。每项都应以当前源码、调用图、测试、数据库和部署产物为准，实际不存在的能力不因本清单而预造。

### 1.1 仓库级边界与装配（已完成）

- 建立 `packages/platform/platform-sdk` 的稳定契约：`ActorContext`、`AccessControlModule`、资源范围与授权查询约束、模块描述符、assembly profile，以及应用基础设施的受限读取入口。
- 为需要参与装配的模块补齐实际 `fenix.module.ts`、`package.json` exports 与显式 workspace dependencies；区分编译依赖与 manifest `dependsOn`，并使它们与 assembly 保持一致。
- 实现受版本控制 workspace 的 manifest 扫描、静态 module registry 生成及其校验；`apps/server`、`apps/web` 只能从生成 registry 选择已编译模块，不能手写业务注册表或动态加载代码。
- 新增并维护 `deploy/assembly/` 中的受控 profile、模块 capability/env/migration preflight 与关闭时的逆序资源释放；profile 不得携带路径、URL、包名或代码。
- 完善架构门禁：阻断跨包内部路径导入、未声明 workspace dependency、循环依赖、未登记的特殊依赖，以及浏览器入口加载服务端模块。
- 核查 `packages/` 中 `platform/`、`agent-runtime/`、`resources/` 以外的现有包（如 `acp-link`、`core`、`chat-channel`、各插件与 provider）：保持其 SDK/插件职责与公开入口，修复包间依赖环和被服务模块错误穿透的内部引用，不要求按资源模块改造；本阶段内不便拆解的环按架构台账逐条登记并写明承担任务与移除条件。

### 1.2 Platform：身份、租户与授权（已完成）

- 将 `packages/resources/identity-admin` 的用户、组织、成员、认证/API Key、DB、route 与 Web 职责迁入新的 `packages/platform/identity`；删除 `identity-admin`，不保留兼容包或 re-export shim。
- 将 `packages/platform/access-control` 收敛为仅依赖 platform-sdk 与 Identity 公开入口的具体授权实现；Identity 与 AccessControl 保持两个独立包，不能互相穿透内部实现。
- 将资源动作的身份、组织上下文和权限判断收敛到 Resource Application Facade；Facade 使用可信 `ActorContext` 和 `AccessControlModule`，Domain Service 不接收 actor，Repository 不读取 member/role 或复制授权 SQL。
- 实现统一授权查询约束，使普通用户的列表、分页、排序、计数、详情和变更动作使用同一范围语义，并在数据库查询前完成限制；保留系统管理员真实 `userId` 的审计主体与 API Key 的组织恢复、保守拒绝行为。
- 迁移并最终删除旧 `resource_permission` 的读取、写入、公开出口及表；迁移期间不得长期保留双写、兼容表或两套授权判断。
- 为跨组织、owner/admin/member、private/public、系统管理员、API Key、拒绝路径及授权查询下推补齐自动化回归。

### 1.3 资源模块的完整交付物

- 将每个有状态资源包按其实际职责补齐唯一 owner 的 domain/service、repository、adapter、schema、migration、route contribution、`web/` contribution、测试与 README；不得在 app 与 package 或新旧包之间保留重复实现。
- 为资源之间真实存在的引用，改为依赖对方包根入口导出的 Domain Service、DTO 或必要的窄端口；禁止导入对方的 `src/**`、repository、schema，禁止 route 调 route。循环关系应改为稳定契约或由 `apps/server` use case 编排。
- 将 AgentConfig 的创建、修改、运行与引用解析收敛到 Facade：完成 `use` 授权、Skill/MCP/模型/知识等引用的有效性校验，生成已授权 LaunchSpec 后再调用 Runtime port。
- 将 Provider 与 Model 收敛到单一模型资源聚合根：Model 严格继承 Provider 权限，不建立独立 owner/visibility；现有模型管理、网关预算、凭证隔离、用量与 API/Web 调用均须迁入这一边界。
- 分别适配现有 `agent-config`、`channel`、`knowledge`、`mcp`、`memory`、`machine`、`model-management`、`observer`、`prod-view`、`sandbox`、`skill`、`task`、`workflow` 等资源包，使其后端、DB、协议入口、前端和测试与唯一 owner 一致；发现尚未归属的 Site、组织管理、系统管理、文件或品牌能力时，按其真实领域补入对应 owner，不留在 app 的领域实现中。
- 各资源的浏览器入口只从 `./web` 导出页面、API client、hook、DTO、i18n 与浏览器组件；补齐 loading、empty、error、retry、无权限、成功反馈和可访问性状态，且不得经重导出加载 Node、DB 或 server-only 代码。
- **分支收敛（与 §1.6 同批，不重复实现）**：本任务的资源包 `web/` 交付物与 §1.6 的 `apps/web` 收敛是同一批文件下沉的两端，`feat/ui-components-demo` 上已有并行实现；其来源量级、重放方式、identity 红线、新包接入与台账削减要求见 §1.6 的「分支收敛（执行本任务时必读）」。

### 1.4 Agent Runtime、Machine 与 Sandbox

- 将 Environment、Agent Instance、运行时生命周期、并发控制、进程/relay、ACP session、交互式 Chat 与 YJS 的运行组合收敛到 `@fenix/agent-runtime`；`core`、`orchestration`、`chat-channel`、`remote-runtime` 继续保持各自独立实现，不复制合并。
- 定义并使用 Runtime 的公开启动、停止、状态与回收 port；Runtime 只能接受已经授权的通用启动输入，不得读取资源表、Actor、role、scope、visibility 或发布状态。
- 将 Machine、Sandbox 保持为独立资源 owner；只暴露给 Runtime 所需的专用公开运行入口，固定依赖为 `agent-runtime → sandbox → machine` 及 `agent-runtime → machine`，严格禁止反向依赖。
- 收敛 HTTP/OpenAI、Workflow 与交互式 Chat 三条链路到唯一的 Runtime、relay 与 ACP 规则，保持持久 runtime、lease、session、YJS、ACP/RCS ID、重连、背压与 dispose 的既有不变量。
- 补齐 Machine 远端不可用不回退本地文件系统、workspace/symlink 越界、消息大小、超时、取消、并发、断连和资源释放的边界验证。

### 1.5 apps/server：宿主与协议聚合

- 将 `apps/server` 收敛为进程入口、认证 adapter、协议聚合、OpenAPI、通用错误/CORS/static/logger、环境变量、应用基础设施初始化与统一关闭编排；迁出其中的资源领域规则、具体业务 service/repository 和资源页面实现。
- 将 `/web/*`、`/api/*`、ACP、MCP、Webhook、SSE、WebSocket 路由改为模块 route contribution 由宿主挂载；route 只做协议校验、认证上下文、DTO 转换、调用 Facade 与错误映射，不直接访问 DB 或调用其他 route。
- 将已发布 `/api/*`、内部 `/web/*` 和协议入口统一为同一 Facade 的薄 adapter；保持既有对外稳定合同，不能形成第二套 CRUD 或业务流程。
- 把 `process.env` 的读取与校验、DB client 创建、模块配置拆分和进程级资源关闭集中在 `apps/server`；调用 `initializeApplicationInfrastructure()` 后，包从 `@fenix/platform-sdk/server` 读取已注册的 DB/config，不得依赖 `apps/server` 内部路径。

### 1.6 apps/web：Shell 与资源页面装配

- 将 `apps/web` 收敛为最终 WebShell、登录与全局 Provider、品牌/布局/导航容器、错误边界及 TanStack Router 薄 route adapter；把资源页面、领域 API client、hook、i18n 与领域组件迁入所属资源包的 `web/`。
- 让 WebShell 从静态 registry 的资源 web contribution 收集导航、路由与页面，不允许资源模块反向决定全局布局，也不允许运行时注入路由或远程脚本。
- 保持文件路由和生成 `routeTree` 的工具链；不手改生成文件。前端仅通过 API client 访问后端，前端可见性不能替代服务端授权。
- 核查并修复构建别名、Vite 入口、静态资源、路由、测试与生产静态挂载，确保浏览器 bundle 不含 server-only 依赖。
- **分支收敛（执行本任务时必读）**：本任务与 §1.3 在 `feat/ui-components-demo` 上有并行实现（自 `d8e29658b` 分叉：250 新增 / 298 修改 / 32 重命名 / 0 删除）。阶段 1 已把其中的 `@fenix/ui-components` 与 `@fenix/web-runtime` 前置落地（未接线），接入与资源包下沉按本条执行。
  - **收敛方式：重放，不做整体合并。** 518 个文件可直接取用；只有 62 个双方都改过，需以本分支逻辑为主融合——本分支侧的改动集中在授权语义（`resourceAccess` → `scope` + `access.actions`），该分支侧绝大多数只是 import specifier 改写。
  - **identity 红线**：该分支把身份 web 职责落到了已于 §1.2 删除的 `packages/resources/identity-admin`。**不得落盘该包**；其 18 个改动全是 import 改写、零业务逻辑，按职责重定向即可。`lib/admin-key.ts` 保留在 `apps/web/src/lib/admin-key.ts` 原位（6 个资源包经 `@/src/lib/admin-key` 引用）。收尾硬检查 `git grep -n 'identity-admin'` 必须为 0。
  - **新包接入**：17 个消费包补 workspace 依赖声明。**该分支的绿灯不能作为依据**——它的 `.dependency-cruiser.cjs` 缺 `exportsFields` / `tsConfig`，`@fenix/*` 解析失败会让 `undeclared-workspace-dependency` 静默漏报。5 个自带 `paths` 的包 tsconfig（`agent-runtime`、`chat-channel`、`resources/{agent-config,model-management,memory}`）各补 `@fenix/*` 条目（`paths` 在 extends 链上是**覆盖而非合并**）。`apps/web/vite.config.ts` 的别名须指向包的 `web/` **目录**而非入口文件（字符串别名按前缀替换，指向 `index.ts` 会得到 `.../index.ts/api/request`）。
  - **台账同批削减**：`scripts/architecture/exceptions.json` 中本任务名下的 `web-package-not-to-app`、本阶段为 `@fenix/web-runtime` 登记的 `no-cross-package-src:packages/chat-channel` 等条目，须按实际残留**在同一批**改完——`scripts/check-dependency-boundaries.ts` 对「已不再违规」的条目直接失败。这些条目的 `removeWhen` 写的是「改经 WebShell 公开面**或包内自持**」，本任务走的正是「包内自持」。
  - **已知偏离**：`web-runtime/web/chat/structured-to-thread.ts` 读取 Chat Doc，与 `@fenix/chat-channel` 形成包级互引。经核查**不触发** `no-circular`（该规则是模块级闭环，出边落在 `chat-channel/src/index.ts` 而 `src/**` 不反向引用），但触发 `no-cross-package-src`——`chat-channel` 的 `exports["."]` 即 `./src/index.ts`，规则按解析后的最终路径判定，浏览器侧没有更合适的入口（`./server` 会把 node 依赖带进 bundle）。本任务按最小改动落地，把这份「Chat Doc → 展示结构」投影层交还 `packages/chat-channel/web/lib/`，而不是改写导入。
  - **包内测试基础设施**：`@fenix/ui-components` 的 5 个 happy-dom 测试需要 `initializeHappyDomWindow`——happy-dom 把 `SyntaxError` 等 JS 全局定义成 Window 实例上值为 `undefined` 的可写属性，其 `SelectorParser` 会 `new this.window.SyntaxError(...)`，任何 `querySelectorAll` 都抛 `undefined is not a constructor`。为不新增 `apps-boundary` / `web-package-not-to-app` 台账条目，阶段 1 在包内落了 `web/__tests__/happy-dom-window.ts`。该 workaround 全仓已有 15 个用例（本包 5 + 既有 10），本任务应收敛为一个跨包测试工具入口（参照 `@fenix/resource-machine/server/testing` 的 `/testing` 子路径先例）并迁走全部调用方；在那之前它与 `apps/web/src/__tests__/happy-dom-window.ts` 两份实现必须同步修改。
  - **文案断言的环境依赖（本批已修，迁移时须重新核对）**：`apps/web` 与各包的测试跑在同一 bun 进程里，`useTranslation` 的取值取决于同进程其他测试文件：组件的 import 图可能初始化宿主 i18n 单例（`apps/web/src/i18n/index.ts`），因而返回真实译文；也可能因为别的测试文件对 `react-i18next` 登记了模块 mock（全仓 6 处，如 `packages/agent-runtime/web/__tests__/file-picker-panel.test.tsx`）而回显 key——该 mock 会残留到后续文件，且此时宿主单例本身仍是真实实例（2026-09-20 用临时探针实测：整包跑时 `@/src/i18n` 仍带 `getFixedT`、语言 `en-US`，但 `t()` 已回显 key）。只认单一形态的断言在两种环境下互相矛盾，且**两个方向都会出错**——实测 `packages/agent-runtime/web/__tests__/chat-composer.test.tsx` 单文件跑 21 pass、整包跑 6 fail（该文件不注入 provider 也不 import 宿主 i18n，单跑时进程内没有可用实例、按 i18next 自身回退返回 key；整包时宿主单例已被同进程初始化）；同一组件的 `chat-composer-ssr.test.tsx` 恰好相反，整包跑绿、单跑 8 pass / 3 fail（该文件自带 `I18nextProvider`，单跑是真实译文；整包时被残留的 `react-i18next` 模块 mock 覆盖成 key 回显）。本批处置分两类，均已单跑与整包验证：**改为双形态** 3 个文件 10 处（`packages/agent-runtime/web/__tests__/chat-composer.test.tsx` 6 处、同目录 `chat-composer-ssr.test.tsx` 3 处、`apps/web/src/__tests__/agent-resource-picker-interaction.test.tsx` 1 处），同时接受「译文」与「key 回显」；**删除 key 断言** 6 个文件 14 处（`packages/agent-runtime/web/__tests__/tool-call-row-ssr.test.tsx` 6 处、同目录 `chat-empty-state.test.tsx` 3 处、`packages/agent-runtime/web/src/__tests__/message.ssr.test.tsx` 3 处、`apps/web/src/__tests__/data-table-ssr.test.tsx` 1 处、`apps/web/src/__tests__/message-additional-ssr.test.tsx` 1 处、`packages/resources/knowledge/web/src/__tests__/context-panel-ssr.test.tsx` 3 处），只保留与 i18n 状态无关的断言（结构类名、`data-*`、调用方传入的字面量、否定断言）；其中 3 个用例删后只剩否定断言会退化为恒真，改按等价稳定锚点断言（`.tool-call-row-status` 类名、Radix `aria-expanded="false"`），原因写在用例注释里。**这批断言不能只跑整包验证**，改动后每个文件都已单跑。`web/` 页面迁入包内后测试与字典的相对位置改变，同一批断言需重新核对。
  - **顺带发现（本批未修）**：`packages/agent-runtime/web/components/chat/{ChatQuoteMessage,composer-assets}.tsx` 使用的 `composerAssets.quoteTruncatedBadge` 在宿主 `apps/web/src/i18n/locales/{en,zh}/components.json` 中**不存在**——同名键只落在 `packages/ui-components/web/i18n/locales/*/uiComponents.json`，且带 `chat.components.` 前缀，宿主 i18n 也未注册该命名空间。因此引用被截断时徽标会直接显示原始 key（原测试正是以「key 回显」断言固化了这一现象，证据即该断言本身）——属用户可见 i18n 缺陷，本批按同一规则删除该断言，缺陷本身待与 `@fenix/ui-components` 接入一起处置（→ 已由 §1.6 T9b 修复：zh 译文补齐、被删断言按真实译文恢复，证据见 `review/task-1.6-web-shell.md` §7.16）。另：`setup-mocks.ts` 中「react-i18next 不可用时按需注册 mock」的探针与回退分支已**删除**——其前提已证伪（`bun.lock` 的 integrity 与 registry.npmjs.org 的 `dist.integrity` 逐字节一致，CI 走 `bun install --frozen-lockfile`），实测探针恒为 true、回退分支从未注册，整段删除后 `precheck` 仍全绿；若将来 Bun 对根入口 named export 的解析真的回归，表现为 import 期直接失败，比 mock 兜底更易定位。
  - **依赖升级策略**：该分支带来的 42 项版本变更（含 4 个 major：`ai` ^6→^7、`motion` ^12→^13、`nanoid` ^5→^6、`react-day-picker` ^9→^10）**默认不做**；只有开发中确认「必须升级某项才能完成」时才升级该项并写明原因，非必需的保持不动。两个新包的依赖已在阶段 1 对齐到根版本，其落地不构成升级；`ai` 是后端依赖（`apps/server` 在用），不因本次前端收敛升级。

### 1.7 DB、配置、迁移与交付

- 将表、索引和 schema 的唯一真相迁到实际 owner 模块；`drizzle.config.ts` 只显式聚合 schema 路径，不定义或 re-export 表；已发布的 SQL、snapshot、journal 不得改写。
- 建立模块就近的数据迁移 manifest：包含全局唯一 ID、依赖、幂等分批 `run`、`verify`、可观测字段和补偿方案；仓库 `db/data-migration-runner.ts` 只负责汇总、排序、记录和执行，应用启动不自动运行业务数据迁移。
- 为空库与真实历史升级库补齐 migration smoke，覆盖 DDL、数据迁移重试、verify、补偿、锁风险与完成记录。
- 将模块 env 声明、配置冲突校验、密钥保护、Provider/Sandbox/子进程环境白名单收敛到设计规定的边界；模块不得直接读 `process.env` 或 `.env`，前端不得获得 server secret。
- 整理 `scripts/`、`deploy/compose/`、镜像构建、无密钥 env 模板、migration、data migration、preflight、readiness、SBOM、备份、回滚与不可逆迁移补偿的交付链路；脚本只做薄编排，不承载业务逻辑。

### 1.8 日志、测试、文档与收口证据

- 保持并规范 `@fenix/logger` 与请求 ALS：HTTP 入口创建并返回 `requestId`，异步任务/实例/relay 显式传递关联 ID；日志记录关键状态、重试、超时和外部失败，但不记录密钥、Cookie、连接串、完整 prompt/文件或未脱敏响应。
- 迁移、补充并运行资源级、跨包 contract、授权隔离、Runtime、协议、前端、迁移和部署测试；测试入口与 CI 必须扫描新目录。
- 更新实际架构、开发指南、运维说明、模块 README 和必要 ADR，使其与最终代码、公开接口、部署和迁移方式一致；移除过期说明与临时边界豁免。
- 完成目录 owner、依赖图、公开出口、授权、三条 Agent 通信路径、Web bundle、DB/迁移、镜像启动与关闭、deploy preflight/readiness、回滚演练和关键 E2E 的最终证据，并确保 `bun run precheck`、`bun run build:web`、`bun run docs:build` 及相关 migration/E2E 检查通过。
