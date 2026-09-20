# @fenix/resource-workflow

工作流定义、版本、运行与触发的 owner：YAML 从草稿到发布、DAG 执行、SSE 事件流、Webhook 触发的服务端规则都收敛在本包；控制台画布与运行面板也由本包的浏览器出口交付。

## 职责

- **定义与版本**：`src/server/repositories/workflow-def.ts` 维护定义、版本与快照三类记录，`src/server/routes/web/workflow-defs.ts` 是其协议层（列表、草稿保存、发布、版本历史、recover 扫描）。
- **运行与审批**：`src/server/repositories/workflow-trigger.ts` 之外的 run/event/node output 读写收敛在 `workflow-runs` 路由与 `pg-storage-adapter`；`src/server/routes/web/workflow-runs.ts` 提供列表、dry run、取消、审批、单节点输出、recover 与 rerun。
- **执行编排**：`src/server/services/workflow/index.ts` 的 `getTeamEngine(organizationId)` 按组织缓存一对 `(engine + transport)`——storage 按 organizationId 隔离、engine 内部持有 activeRuns（取消与审批状态），不能跨组织或跨请求重建；`workflow-execute.ts` 把 `/api/workflows/:workflowId/execute` 的同步成功 / 失败 / 超时收敛为单一结果类型。
- **Agent 通信**：`agent-chat-transport.ts` 解析并确保当前用户的持久 `workflow/primary` 实例 runtime，每个节点使用独立 relay/ACP session；`instance-lease.ts` 保护同一实例的并发持有权，run 结束后只停止本 run 创建的实例，被租约保护的实例交给最后使用者释放。
- **持久化适配**：`pg-storage-adapter.ts` 实现 engine 的 `StorageAdapter`（run / event / node output 落 PG）。
- **触发与 Webhook**：`services/workflow-trigger.ts` 管理 `workflow_trigger`，对外只暴露 masked hash；`handleWebhookRequest` 供宿主 `POST /hooks/:publicHash` 调用，异步触发后立即 200。
- **自定义节点**：`custom-tools.ts` 扫描模块配置的 `toolsDir`（缺省 `<cwd>/tools`），实例化 `CustomNode` 子类注册进 registry；目录缺失或加载失败降级为空 registry，不阻塞启动。
- **HTTP 交付物**：会话守卫保护的 `/web/*` 控制台路由（宿主挂载在 `/web` 前缀下）：`GET|POST|PUT|PATCH|DELETE /workflow-defs*`、`GET|POST /workflow-runs*`、`POST /workflow-engine`、`GET /workflow/:workflowId/events`（SSE）、`GET /workflow-custom-tools`，以及 `/workflow-ui` 静态代理；`POST /api/workflows/:workflowId/execute` 是对外 API。
- **浏览器侧**：`web/index.ts` 是浏览器出口（`exports["./web"]`），导出四个 API client、`WorkflowList` / `WorkflowRuns` / `WorkflowVersions` / `WorkflowBreadcrumb` 与画布纯逻辑（布局、预设、事件格式化），另经 `@fenix/resource-workflow/web/i18n` 交付 `workflowResources` / `WORKFLOW_NS`；页面与组件在 `web/pages/workflow/**`，事件钩子在 `web/lib/use-workflow-events.ts`。
- **模块组合根**：`src/module.ts` 的 `createWorkflowModule()` 返回进程级单例（`engines` / `customTools`），`fenix.module.ts` 是它的惰性描述符。

## 依赖边界

本包属 `resources` 类别。依赖矩阵（`scripts/lib/architecture-boundary-rules.ts`）禁止 `resources → platform-impl`：

- **不得**导入 `@fenix/identity/*` 或 `@fenix/access-control/*`；需要的身份数据只能经 `@fenix/platform-sdk` 的窄契约取得。
- 其它包只经对方包根入口引用（`@fenix/*` 或 `@fenix/*/<公开子路径>`），零 `@fenix/*/src/**`。实测跨包面：`@fenix/agent-runtime`（`/server` 的实例生命周期与事件总线、根入口的 `ChatPanel`、`/web/api/environments`）、`@fenix/agent-config/web`（`ensureMetaAgent`）、`@fenix/workflow-engine`（engine、YAML 解析、`CustomNodeRegistry`）、`@fenix/platform-sdk`（响应信封、`getDatabase` / `getModuleConfig`）、`@fenix/logger`、`@fenix/plugin-sdk`（仅 `import type`）。
- 浏览器面另有 `@fenix/ui-components/*`（UI 基础组件与 `ConfirmDialog`）与 `@fenix/web-runtime/*`（`api/request`、chat 上下文队列）；这些子路径是 §6.5 的共享模块归属裁定，不是包的内部路径。
- `apps/server` 是唯一合法装配者（挂载路由、注入守卫、初始化模块配置与 DB）。宿主对 workflow 的反向装配边登记在架构台账，owner 1.5。

## 守卫由宿主注入

`authGuardPlugin` **不是**本包的导出。Elysia 的 `macro` / `state` 是实例作用域的，父实例无法向已构造的子实例回填；而守卫必须与宿主的认证解析（含 `setTestAuth` 测试 seam 与 active organization 解析）是同一份实例——两份同名实例会被 Elysia 按 plugin `name` 去重，导致先构造的一方静默生效。

因此所有路由以**工厂**形式导出，由宿主注入守卫：

```ts
import {
  createApiWorkflowRoutes,
  createWebWorkflowCustomToolsRoutes,
  createWebWorkflowDefsRoutes,
  createWebWorkflowEngineRoutes,
  createWebWorkflowRunsRoutes,
  createWebWorkflowSseRoutes,
  createWorkflowStaticApp,
} from "@fenix/resource-workflow/server";

const workflowDefs = createWebWorkflowDefsRoutes({ authGuardPlugin });
const apiWorkflows = createApiWorkflowRoutes({ authGuardPlugin });
```

依赖类型是 `WorkflowRouteDependencies`（`src/server/routes/dependencies.ts`），只声明守卫与用到的 `{ organizationId, userId }`，不解释 `role` 等身份语义。

包内用例注入 `src/__tests__/guard-stubs.ts` 的替身（只提供工厂注册路由所必需的 `error` 装饰器与同名宏）；「路由 + 真实守卫 + session 契约」这条已发布合同的覆盖归 §1.5 的宿主用例，本包不重复断言（替身放行不等于合同已验）。

## 配置与 DB

本包不读 `process.env`、不读 `.env`，也不导入 `apps/server`：

- 部署配置经 `getWorkflowConfig()`（`getModuleConfig("workflow")` + 包内 zod 形状校验），字段为 `baseUrl`、`acpxGUrl`、`toolsDir?`、`hmacSecret?`；值由宿主从 `apps/server/src/env.ts` 已校验的 env 构造，迁移前的三处直读（`@server/config` 的 `acpxGUrl` / `getBaseUrl`、`process.env` 的 `WORKFLOW_TOOLS_DIR` 与 `RCS_WORKFLOW_HMAC_SECRET`）全部收敛到这里。
- DB 经 `getWorkflowDatabase()`（`@fenix/platform-sdk/server` 的 `getDatabase()`），类型是 `NodePgDatabase<Record<string, never>>`——不耦合宿主的 schema 聚合，表定义迁出时只改这一个文件。
- **读取必须发生在调用时**：模块加载期宿主可能尚未完成基础设施初始化，因此配置与 DB 句柄都在函数内取，不在模块作用域取。
- `src/server/repositories/**` 与 `pg-storage-adapter.ts` 是**全部**取用宿主表定义的位置（`command grep -rn 'from "@server/' src web` 的命中集合只有这三个生产文件 + 一个用例）；`src/server/routes/**` 与其余 service 不得直接取 DB 句柄或表对象。
- 文件存储：`workflow-fs.ts` 的 `WORKFLOW_BASE_DIR = <cwd>/.agents/workflows/<organizationId>/<workflowId>/`，organizationId 在路径中承担租户隔离。
- `hmacSecret` 缺省时每个进程生成一个随机值（`getTeamEngine` 内 `crypto.randomUUID()`）：单实例自洽，多实例部署必须显式配置同一密钥，否则跨实例恢复的 run 会签名校验失败。密钥值不进日志与响应。
- 测试装配走 `@fenix/resource-workflow/server/testing`：`createWorkflowModuleConfig()` 提供字段齐全的配置，`initializeWorkflowModuleConfig()` 经生产读取路径完成替身装配，`stubPgStorageAdapter` / `stubCustomTools` 供路由用例替换本包模块级单例。

`envDefinitions` 与 preflight 收敛在任务 1.7 处理。

## 边界外的已知项

- **表定义仍在宿主**：`@server/db/schema` 是本包对宿主内部实现唯一的依赖面（`command grep -rn 'from "@server/'` 实测命中 4 处，全部是该路径），迁出归 §1.7。
- **宿主调用点已改指到工厂**：`command grep -rn "apiWorkflowRoutes\|workflowStaticApp\|webWorkflowDefs\|webWorkflowSse\|workflowRunsRoutes" apps/server/src` 实测只剩工厂形式——`apps/server/src/routes/web/index.ts:54-58`（5 个 `create*Routes({ authGuardPlugin })`）、`apps/server/src/main.ts:490,494`（`createApiWorkflowRoutes` / `createWorkflowStaticApp`）、`apps/server/src/__tests__/agent-platform-api-reference.test.ts:12`。本包源码不需要改动；仓库根 `bunx tsc --noEmit` 的剩余报错归 W3 串行验证（本轮按切片级命令验收）。
- **宿主 `moduleConfigs` 缺 `workflow` 条目**：`apps/server/src/main.ts:171` 起的 `moduleConfigs` 登记了 identity / machine / knowledge / memory / skill / agent-config / sandbox（`grep -n "workflow"` 在 main.ts 只命中路由 import），而 `getWorkflowConfig()` 经 `getModuleConfig("workflow")` 读取，未登记时平台契约直接抛「模块 workflow 未声明应用基础设施配置」（`@fenix/platform-sdk/src/server.ts:69-71`）。影响面是**启动期**：`apps/server/src/main.ts:371` 的 `await initCustomToolsRegistry()` 在函数体第一段就调用 `getWorkflowConfig()`（`src/server/services/workflow/custom-tools.ts:31`，不在降级 `catch` 内），未登记配置会让服务起不来；请求路径上的 `/workflow-ui` 代理、`/web/workflow-defs` 与 webhook 触发同样会失败。期望条目：`workflow: { baseUrl: getBaseUrl(), acpxGUrl: config.acpxGUrl, toolsDir: env.WORKFLOW_TOOLS_DIR, hmacSecret: env.RCS_WORKFLOW_HMAC_SECRET }`（`WorkflowModuleConfigSchema` 是 `strictObject`，字段名或多余键会立刻失败；后两项可省略——省略即回到「每进程随机签名密钥 + `<cwd>/tools`」的迁移前默认）。`RCS_WORKFLOW_HMAC_SECRET` 目前不在 `apps/server/src/env.ts` 的 schema 里（变量收敛归 §1.7），宿主接线时必须二选一：声明该变量，或省略 `hmacSecret`。
- **宿主 i18n 未改线**：`apps/web/src/i18n/index.ts:27-28` 仍以深相对路径直接 import 本包字典 JSON，并把 `WORKFLOWS: "workflows"` 写在宿主的 `NS` 表里；本包已按 §4 统一形状把字典放到 `web/i18n/locales/{en,zh}/workflows.json` 并经 `@fenix/resource-workflow/web/i18n` 交付 `workflowResources` / `WORKFLOW_NS`。**宿主改线必须与字典路径切换同批落地**：旧路径 `web/i18n/{en,zh}/workflows.json` 已不存在，宿主未改线时启动即解析失败（宿主 patch 清单见任务 sharedPatches）。
- **宿主残留副本**：三份零引用宿主副本已于 W3 删除——`apps/web/src/lib/use-workflow-events.ts`（与包内 `web/lib/use-workflow-events.ts` **曾是同一份实现**，`diff` 只差 1 行 import 说明符：`./context-queue` vs `@fenix/web-runtime/chat/context-queue`；本包用例只断言「不得再被引用」）、`apps/web/components/MetaAgentPanel.tsx`（与包内 `web/pages/workflow/components/MetaAgentPanel.tsx` 只差 import 路径与注释，零导入方）与 `apps/web/src/hooks/useMetaAgent.ts`（通用 hook，零导入方；其发布方是 `@fenix/agent-config/web` 的 `useMetaAgent`，本包 `useWorkflowMetaAgent` 已自持环境就绪逻辑）。另：本包 `web/index.ts` 暂不导出编辑器（`WorkflowEditor` / `WorkflowPage`），因为它们经 `@fenix/agent-runtime` 的 `ChatPanel` 会撞上 `acp-link` 的 `./websocket-code` 出口不可解析、且链条到达 agent-config 仍带 `@/` 的 web 文件——两处都不是本包可修范围，清掉后应加回。
- **迁入时带来的 lint 错误已清零**：`bunx biome check packages/resources/workflow` 在迁入时带进 10 条 error（`noArrayIndexKey` ×7、`useExhaustiveDependencies` ×3），全部位于 `web/pages/workflow/**`，构造与 `HEAD` 逐字节相同（`git diff HEAD` 实测这些文件只改了 import 说明符）——非本次改动引入，但已逐条收敛：骨架屏与运行/版本列表改用序号派生的键数组（先生成键数组再渲染，不把下标直接交给 React）、`InputsEditor` 的草稿行改用稳定行 id（`entry.key` 用户可编辑、可空可重复，不能当 key）、`WorkflowRuns` / `ParamsEditor` 的两处触发型 effect 用行级 `biome-ignore` 保留触发语义（按建议删依赖会静默丢掉「筛选变化即回第 1 页」与「条目数变化即重置二次确认」）、`useWorkflowPersistence` 的自动保存 effect 删掉多余的 `nodes/edges/meta`（编辑重启定时器已由 `handleSaveDraft` 的引用变化传导）。改法与理由都写在对应文件的注释里；当前该命令 **0 error 0 warning**。
- **测试入口必须在仓库根**：验收命令是仓库根的 `bun test packages/resources/workflow`（39 个文件 699 用例全绿）。直接 `cd packages/resources/workflow && bun test` 会缺仓库根的 preload（`bunfig.toml` 只从 cwd 读取，`bun test --preload ../../../apps/server/src/test-utils/setup-{globals,mocks}.ts` 可复现全绿），当前有 3 个用例依赖该 preload——沙盒黄金样本同样是 3 例，属既有形态而非本包缺陷。
- **执行入口有两个**：`/web/workflow-runs`（RESTful）与 `/web/workflow-engine`（action 分发，文件注释自述为向后兼容）。保留哪些、何时收敛由宿主与协议 owner 裁定，本任务不删。
- **`/workflow-ui` 与包内页面不共用代码**：前者只是转发到 `acpx-g` 的静态代理，后者是包内 React 页面；目标形态由 §1.6 裁定。
