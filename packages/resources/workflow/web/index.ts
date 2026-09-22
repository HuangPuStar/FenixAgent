/**
 * Workflow 控制台浏览器安全入口（`package.json` 的 `exports["./web"]` 必须指向本文件）。
 *
 * 浏览器安全 = 本文件的整条值导入图里不出现 `node:` 内建、`@server/*` 或宿主别名；跨包引用会经对方
 * `exports` 递归进入后一并检查（`@fenix/x/server` 这类子路径同样会现形），由
 * `web/__tests__/workflow-browser-surface.test.ts` 静态走值导入图守护（参照 chat-channel / sandbox 的同名守卫）。
 * 因此这里只导出可在浏览器中执行的模块；服务端能力走 `./server`，`./module` 是模块注册表的组合根出口，
 * 两者都不从这里转出。
 *
 * **编辑器纳入入口的经过（`WorkflowEditor`）**：2026-09-20 曾因两条他人债务把编辑器挡在入口外——经
 * `@fenix/agent-runtime` 的 `ChatPanel` 到 `@fenix/chat-channel` 再到 `acp-link` 的
 * `./websocket-code` 不可解析出口，以及 agent-config web 侧仍带 `@/` 宿主别名的文件。§1.6 期间两条都已
 * 消失：`ChatPanel` 归位宿主、改经 `chatPanel` 端口注入（T6d）；仓库内 `@/` 别名残留已清（T11e）。
 * 2026-09-21 T11e 实测复核：本守卫的硬断言（`node:` / `@server` / `@/` 别名 / 不可解析出口 / 不深入
 * `@fenix/<pkg>/src`）全部通过，只剩白名单需要为新增可达面补录——编辑器因此加回入口，宿主 route adapter
 * 不再经 tsconfig/vite 别名穿透到本包 `web/pages/**`。
 *
 * 编辑器可达面的构成（白名单据此分组收录）：编辑器自身引入 `@xyflow/react`；它经
 * `hooks/useWorkflowMetaAgent.ts` 取 `@fenix/agent-config/web/lib/meta-agent` 的 `ensureMetaAgent` 与
 * `@fenix/agent-runtime/web/api/environments`，其余外部库都随 `@fenix/ui-components` 的共享原语进入。
 *
 * 该跨包腿曾是 T11e 加回入口时的最大噪音源：`ensureMetaAgent` 原从 agent-config 的**包根聚合 barrel**
 * 取（§2.3 的 web 行允许资源包经对方 `./web` 取能力），一次带进 agent-config / mcp / knowledge /
 * memory / model-management 的整片 web 图，本守卫的白名单因此涨到 46 条「可达面的库全集」。T12 给该
 * 函数加了窄子路径出口（`@fenix/agent-config/web/lib/meta-agent`，只含一个 POST 客户端，无页面依赖），
 * 跨包到达面收敛到 `web/lib/meta-agent.ts` 一个文件，白名单回到 20 条「本包/宿主自己的依赖 + 经
 * ui-components 传递的库」。bundle 层面两次形态一致（宿主本来就加载同一批文件），差异在信号精度：
 * 白名单重新等于「本包引了哪些库」。
 *
 * 面按「消费方实际需要」收敛：宿主控制台经本入口消费 `pages/**` 与 `api/**`。包内其余组件
 * （`components/**`）除页面已引用的之外不逐个导出——没有包外消费方时提前铺开会把内部结构固化成公共
 * 契约（CLAUDE.md 原则 7）。
 *
 * 为什么全部用显式命名导出而不是 `export *`：入口是**被守护的契约面**，上面那条「按消费方实际需要收敛」的
 * 原则要求新增导出是一次显式决定；`export *` 会让包内模块的实现细节自动变成公共契约。
 *
 * 2026-09-22：此前 `api/workflows.ts` 与 `api/workflow-defs.ts` 曾各自定义 `WorkflowDefItem` /
 * `WorkflowVersionItem` / `VersionYamlResponse` 三个同名接口（显式导出的一大动因）。该文件是迁移期的
 * 重复实现、`workflowApi` 全仓零消费，已删除；入口的三个 API client 现在是
 * `workflowDefApi` / `workflowEngineApi` / `customToolsApi`（外加 SSE 的四个连接函数）。
 */

export {
  type CustomToolInputDef,
  type CustomToolItem,
  customToolsApi,
  type TriggerItem,
  type VersionYamlResponse,
  type WorkflowDefItem,
  type WorkflowParamDefsResponse,
  type WorkflowVersionItem,
  workflowDefApi,
} from "./api/workflow-defs";
export {
  type DAGEvent,
  type DAGRunResult,
  type DAGSnapshot,
  type DAGStatus,
  type DryRunResult,
  type EventType,
  type NodeOutput,
  type NodeStatus,
  type NodeType,
  type PendingApproval,
  type RunStarted,
  type RunSummary,
  workflowEngineApi,
} from "./api/workflow-engine";
export {
  connectWorkflowSSE,
  disconnectWorkflowSSE,
  hasWorkflowSSE,
  resetWorkflowSSE,
  type WorkflowSSEEvent,
} from "./api/workflow-sse";
export { WORKFLOW_NS, type WorkflowResources, workflowResources } from "./i18n";
export {
  buildRunSummary,
  clearWorkflowEvents,
  disposeWorkflowEvents,
  pushWorkflowError,
  pushWorkflowRunStatus,
  useWorkflowEvents,
} from "./lib/use-workflow-events";
export { autoLayout } from "./pages/workflow/layout";
export { syncExpressionOnKeyRename, syncOutputOnRename } from "./pages/workflow/preset-utils";
export { getPresetById, TRANSFORM_PRESETS, type TransformPreset } from "./pages/workflow/presets";
export { DAG_STATUS_CFG, dedupEvents, formatEventType, formatMeta, relativeTime } from "./pages/workflow/utils";
export { WorkflowBreadcrumb } from "./pages/workflow/WorkflowBreadcrumb";
export { WorkflowEditor } from "./pages/workflow/WorkflowEditor";
export { WorkflowList } from "./pages/workflow/WorkflowList";
export { WorkflowRuns } from "./pages/workflow/WorkflowRuns";
export { WorkflowVersions } from "./pages/workflow/WorkflowVersions";
export {
  createStartNode,
  defaultMeta,
  flowToYaml,
  nextEdgeId,
  nextNodeId,
  resetEdgeCounter,
  resetNodeCounter,
  START_NODE_ID,
  syncEdgeCounter,
  syncNodeCounter,
  type WfMeta,
  yamlToFlow,
} from "./pages/workflow/yaml-utils";
