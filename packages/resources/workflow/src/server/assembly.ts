import type { ServerRouteHost } from "@fenix/platform-sdk/server";
import type { AnyElysia } from "elysia";
import { createApiWorkflowRoutes } from "./routes/api/workflows";
import type { WorkflowRouteDependencies } from "./routes/dependencies";
import { createWebWorkflowCustomToolsRoutes } from "./routes/web/workflow-custom-tools";
import { createWebWorkflowDefsRoutes } from "./routes/web/workflow-defs";
import { createWebWorkflowEngineRoutes } from "./routes/web/workflow-engine";
import { createWebWorkflowRunsRoutes } from "./routes/web/workflow-runs";
import { createWebWorkflowSseRoutes } from "./routes/web/workflow-sse";

/**
 * Workflow 的路由贡献装配面：把宿主协议面收窄为本包路由的注入依赖。
 *
 * `ServerRouteHost` 的字段全是 `unknown`（platform-sdk 不依赖 elysia，见 review §3.3），收窄只能在包内做
 * 一次——五条路由都需要 `WorkflowRouteDependencies` 里的会话守卫。这里不做校验：端口是否可用由宿主在装配
 * 处保证（`apps/server/src/bootstrap/route-host.ts` 是唯一实现）。
 *
 * 导出的是**构造函数**而不是实例：Elysia 的 macro / state 是实例作用域的，路由必须在宿主 app 构造前完成
 * 构造，构造时机由宿主装配决定，故本文件不持有任何状态。五条路由的挂载顺序与迁移前宿主手写序列一致
 * （defs → custom-tools → engine → sse → runs）：同路径冲突时的匹配结果取决于挂载顺序，用例要看到与生产
 * 相同的形状。
 */

/** 把宿主协议面收窄为本包路由的依赖。 */
function routeDependencies(host: ServerRouteHost): WorkflowRouteDependencies {
  return { authGuardPlugin: host.authGuardPlugin as AnyElysia };
}

/** `/web/workflow-defs` 工作流定义管理（挂宿主 `web` 聚合槽）。 */
export function createWorkflowWebDefsRoutes(host: ServerRouteHost) {
  return createWebWorkflowDefsRoutes(routeDependencies(host));
}

/** `/web/workflow-custom-tools` 自定义工具管理（挂宿主 `web` 聚合槽）。 */
export function createWorkflowWebCustomToolsRoutes(host: ServerRouteHost) {
  return createWebWorkflowCustomToolsRoutes(routeDependencies(host));
}

/** `/web/workflow-engine` 引擎控制（挂宿主 `web` 聚合槽）。 */
export function createWorkflowWebEngineRoutes(host: ServerRouteHost) {
  return createWebWorkflowEngineRoutes(routeDependencies(host));
}

/** `/web/workflow-sse` 事件流（挂宿主 `web` 聚合槽）。 */
export function createWorkflowWebSseRoutes(host: ServerRouteHost) {
  return createWebWorkflowSseRoutes(routeDependencies(host));
}

/** `/web/workflow-runs` 运行记录与回放（挂宿主 `web` 聚合槽）。 */
export function createWorkflowWebRunsRoutes(host: ServerRouteHost) {
  return createWebWorkflowRunsRoutes(routeDependencies(host));
}

/** `/api/workflows/:workflowId/execute` 对外工作流执行（挂宿主 `api` 聚合槽）。 */
export function createWorkflowApiRoutes(host: ServerRouteHost) {
  return createApiWorkflowRoutes(routeDependencies(host));
}
