# @fenix/resource-workflow

工作流定义、版本、运行与触发的唯一 owner：YAML 从草稿到发布、DAG 执行、SSE 事件流、Webhook 触发的全部服务端规则都收敛在本包。

## 职责

- **定义与版本**：`src/server/repositories/workflow-def.ts` 维护定义、版本与快照三类记录，`src/server/routes/web/workflow-defs.ts` 是其协议层（列表、草稿保存、发布、版本历史、recover 扫描）。
- **执行编排**：`src/server/services/workflow/index.ts` 的 `getTeamEngine(organizationId)` 按组织缓存一对 `(engine + transport)`——storage 按 organizationId 隔离、engine 内部持有 activeRuns，不能跨组织或跨请求重建；`workflow-execute.ts` 把 `/api/workflows/:workflowId/execute` 的同步成功 / 失败 / 超时收敛为单一结果类型。
- **Agent 通信**：`agent-chat-transport.ts` 解析并确保当前用户的持久 `workflow/primary` 实例 runtime，每个节点使用独立 relay/ACP session；`instance-lease.ts` 保护同一实例的并发持有权，run 结束后 `cleanupSpawnedInstances` 只停止本 run 创建的实例，被租约保护的实例交给最后使用者释放。
- **持久化适配**：`pg-storage-adapter.ts` 实现 engine 的 `StorageAdapter`（run / event / node output 落 PG）。
- **触发与 Webhook**：`services/workflow-trigger.ts` + `repositories/workflow-trigger.ts` 管理 `workflow_trigger`，对外只暴露 masked hash；`handleWebhookRequest` 供宿主 `POST /hooks/:publicHash` 调用，异步触发后立即 200。
- **自定义节点**：`custom-tools.ts` 启动时扫描 `WORKFLOW_TOOLS_DIR`（默认 `./tools`），实例化 `CustomNode` 子类注册进全局 registry；目录缺失或加载失败降级为空 registry，不阻塞启动。
- **HTTP 交付物**：`/web/workflow-defs`、`/web/workflow-runs`、`/web/workflow-engine`（action 分发）、`/web/workflow/:workflowId/events`（SSE）、`/web/workflow-custom-tools`、`/api/workflows/:workflowId/execute`，以及 `/workflow-ui` 静态代理。
- **浏览器侧**：`web/api/` 四个 client、`web/pages/WorkflowPage.tsx` 与 `web/pages/workflow/**`（画布、编辑面板、运行/版本面板）、`web/i18n/{zh,en}/workflows.json`。

## 依赖边界

- 本包 `src/**` 不导入任何其它已注册 `resource` 模块，manifest 因此声明 `dependsOn: []`。
- 跨包依赖只有：`@fenix/agent-runtime/server`（实例生命周期、事件总线）、`@fenix/workflow-engine`（engine、YAML 解析、`CustomNodeRegistry`）、`@fenix/platform-sdk`（WebOk / WebErr / ApiError 响应信封）、`@fenix/logger`、`@fenix/plugin-sdk`（仅 `import type`）。
- 不得导入 `@fenix/identity/*` 与 `@fenix/access-control/*`（依赖矩阵禁止 `resources → platform-impl`），身份数据只能经 `@fenix/platform-sdk` 的窄契约取得。
- 宿主内部反向依赖已由架构台账登记，必须消除而非长期保留：`apps-boundary`（→ `@fenix/server-app`，77 处 / 35 文件，owner 1.5）与 `web-package-not-to-app`（→ `@fenix/web-app`，68 处 / 28 文件，owner 1.6）。

## 守卫由宿主注入

现状与 sandbox 不同，如实记录：

- 路由是**已构造的 Elysia 实例**并按 default export（`workflow-defs.ts:103`、`workflow-runs.ts:53`、`workflow-engine.ts:23`、`workflow-sse.ts:18`、`workflow-custom-tools.ts:13`、`api/workflows.ts:25`；`workflow-runs.ts:649` 另有具名 `workflowRunsRoutes`），实例内部直接 `import { authGuardPlugin } from "@server/plugins/auth"`。
- 因此守卫与宿主天然是同一份实例，不存在 Elysia 按 plugin `name` 去重导致的双实例风险；代价是包的方向被固化为「宿主插件模块 → 资源包」，而这正是 1.5 要消除的边。
- 包内服务端用例同样直接用宿主 seam：`setTestAuth` / `setTestOrgContext`（`@server/plugins/auth`、`@server/services/org-context`），并由根 `bunfig.toml` 预加载 `apps/server/src/test-utils/setup-mocks.ts`，桩掉 `pg-storage-adapter` 与 `custom-tools`。
- 改为「工厂 + 守卫注入」形态（对齐 sandbox 的 `createWebXxxRoutes({ authGuardPlugin })`）归 W2 切片，宿主调用点由 1.5 一并改指。

## 配置与 DB

- 表定义仍在宿主：`@server/db/schema` 提供 `workflow`、`workflow_version`、`workflow_snapshot`、`workflow_event`、`workflow_node_output`、`workflow_trigger` 与 `environment`，迁出归 §1.7。
- 文件存储：`workflow-fs.ts` 的 `WORKFLOW_BASE_DIR = <cwd>/.agents/workflows/<organizationId>/<workflowId>/`，organizationId 在路径中承担租户隔离——recover 扫描跨组织泄露的唯一屏障就是这一层。
- 直读环境变量三处：`WORKFLOW_TOOLS_DIR`、`RCS_WORKFLOW_HMAC_SECRET`（自定义节点目录与 engine 签名密钥）、`process.cwd()`（文件存储根）；尚无 `envDefinitions`，收敛归 §1.7。
- `src/server/repositories/**` 与 `pg-storage-adapter.ts` 是主要数据访问点；`agent-chat-transport.ts:29` 与 `workflow-engine.ts` / `workflow-runs.ts` 仍直连 `db`，属待收敛的历史写法。

## 边界外的已知项

- **没有 `web/index.ts` 浏览器出口**：`package.json` 只有 `.` 与 `./server`（`.` 现为 `export {}`）。宿主目前用相对路径直接导入 `web/i18n/*.json` 自行拼装文案（`apps/web/src/i18n/index.ts:27-28`），页面组件尚未被宿主消费。出口形状与接线归 §1.6 WebShell。
- **路由未做「工厂 + 守卫注入」**：仍是 default export 的已构造实例，形态改造归 W2 切片。
- **没有 `src/module.ts` 单例**：`getTeamEngine()` 的进程级缓存（`Map<organizationId, TeamRuntime>`）散在 `services/workflow/index.ts`，组合根与 manifest 的 `create` 归 W2 切片。
- **执行入口有两个**：`/web/workflow-runs`（RESTful）与 `/web/workflow-engine`（action 分发，文件注释自述为向后兼容）。保留哪些、何时收敛由 1.5 与协议 owner 裁定，本任务不删。
- **前端有两条并行路径**：`/workflow-ui` 只是转发到 `acpx-g` 的静态代理，与包内 `web/pages/WorkflowPage.tsx` 不共用代码；目标形态由 §1.6 裁定。
- **`@fenix/chat-channel` 在 `package.json` 声明但源码零导入**（`src/**`、`web/**` 均无引用），属依赖清理项，owner 1.5。
