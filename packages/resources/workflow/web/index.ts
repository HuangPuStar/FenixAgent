/**
 * Workflow 控制台浏览器安全入口（`package.json` 的 `exports["./web"]` 必须指向本文件）。
 *
 * 浏览器安全 = 本文件的整条值导入图里不出现 `node:` 内建、`@server/*` 或宿主别名；跨包引用会经对方
 * `exports` 递归进入后一并检查（`@fenix/x/server` 这类子路径同样会现形），由
 * `web/__tests__/workflow-browser-surface.test.ts` 静态走值导入图守护（参照 chat-channel / sandbox 的同名守卫）。
 * 因此这里只导出可在浏览器中执行的模块；服务端能力走 `./server`，`./module` 是模块注册表的组合根出口，
 * 两者都不从这里转出。
 *
 * **为什么暂不导出编辑器（`WorkflowEditor` / `WorkflowPage`）**：它们的值导入图会穿到别的包——经
 * `@fenix/agent-runtime` 的 `ChatPanel` 到 `@fenix/chat-channel`，再撞上 `acp-link` 的
 * `./websocket-code` 出口不可解析（2026-09-20 实测，`git show` 未改动的第三方债务）；同一链条还会到达
 * agent-config web 侧仍带 `@/` 宿主别名的文件。这两处都不是本包可修的范围（前者属 chat-channel/acp-link
 * owner，后者属 agent-config 的 L2 切片），若把编辑器纳入入口，本守卫的「全图无违规」断言会被他人债务
 * 长期染红，反而失去回归信号。编辑器本身的 `@/` 清理已完成（静态条件 2 对本包 `web/**` 全覆盖），
 * 宿主仍按既有 tsconfig/vite 别名消费它；两处债务清掉后应把 `WorkflowEditor` / `WorkflowPage` 加回本入口
 * （已登记为 openIssue）。
 *
 * 面按「消费方实际需要」收敛：宿主控制台经 tsconfig/vite 别名消费 `pages/**` 与 `api/**`
 * （`@/src/pages/workflow/*`、`@/src/api/workflow-*`）。包内其余组件（`components/**`）除页面已引用的之外
 * 不逐个导出——目前没有包外消费方，提前铺开会把内部结构固化成公共契约（CLAUDE.md 原则 7）。
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
