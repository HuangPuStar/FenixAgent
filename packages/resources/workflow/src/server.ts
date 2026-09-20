/**
 * Workflow 资源包的服务端公开入口。
 *
 * 全部导出都是**具名**的（没有 default export）：宿主按需求组装，模块注册表按 `./module` 取组合根，
 * 三条消费路径互不干扰。
 *
 * 路由一律以工厂形式导出并要求宿主注入认证守卫（`WorkflowRouteDependencies`）：Elysia 的 `macro` / `state`
 * 是实例作用域的，父实例无法向已构造的子实例回填，守卫必须与宿主的认证解析是同一份实例。
 */

export { createApiWorkflowRoutes } from "./server/routes/api/workflows";
export type { WorkflowActorContext, WorkflowRouteDependencies } from "./server/routes/dependencies";
export { createHookRoutes } from "./server/routes/hooks";
export { createWebWorkflowCustomToolsRoutes } from "./server/routes/web/workflow-custom-tools";
export { createWebWorkflowDefsRoutes } from "./server/routes/web/workflow-defs";
export { createWebWorkflowEngineRoutes } from "./server/routes/web/workflow-engine";
export { createWorkflowStaticApp } from "./server/routes/web/workflow-proxy";
export { createWebWorkflowRunsRoutes } from "./server/routes/web/workflow-runs";
export { createWebWorkflowSseRoutes } from "./server/routes/web/workflow-sse";
export { initCustomToolsRegistry } from "./server/services/workflow/custom-tools";
export { handleWebhookRequest } from "./server/services/workflow-trigger";
