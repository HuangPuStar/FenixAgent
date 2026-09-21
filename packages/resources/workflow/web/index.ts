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
 * `hooks/useWorkflowMetaAgent.ts` 取 `@fenix/agent-config/web` 的 `ensureMetaAgent` 与
 * `@fenix/agent-runtime/web/api/environments`，而 agent-config 的包根入口是聚合 barrel（§2.3 的 web 行
 * 允许资源包经对方 `./web` 取能力），于是一次性带进 agent-config / mcp / knowledge / memory /
 * model-management 的整片 web 图与其浏览器库。这条 fan-out 是既有形态、不是本包引入的，bundle 层面
 * 也与加回入口前一致（宿主本来就按别名加载同一批文件）；代价是白名单从「本包引了哪些库」变成「本包
 * 可达面的库全集」，信号更粗——已在 `review/task-1.6-web-shell.md` 登记，收窄手段是为 agent-config
 * 的 `ensureMetaAgent` 增加窄子路径出口。
 *
 * 面按「消费方实际需要」收敛：宿主控制台经本入口消费 `pages/**` 与 `api/**`。包内其余组件
 * （`components/**`）除页面已引用的之外不逐个导出——没有包外消费方时提前铺开会把内部结构固化成公共
 * 契约（CLAUDE.md 原则 7）。
 *
 * 命名冲突说明：`api/workflow-defs` 与 `api/workflows` 都定义了 `WorkflowDefItem` / `WorkflowVersionItem` /
 * `VersionYamlResponse`，因此这里全部用显式命名导出，不用 `export *`。
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
export { workflowApi } from "./api/workflows";
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
