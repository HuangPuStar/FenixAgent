import type { ServerRouteHost } from "@fenix/platform-sdk/server";
import type { AnyElysia } from "elysia";
import { createCanvasBffRoutes } from "./routes/canvas/bff";
import { createCanvasStaticRoutes } from "./routes/canvas/static-proxy";
import type { WorkflowV2RouteDependencies } from "./routes/dependencies";
import { createWebWorkflowV2Routes } from "./routes/web";

/**
 * Workflow V2 的路由贡献装配面：把宿主协议面收窄为本包路由的注入依赖。
 *
 * `ServerRouteHost` 的字段全是 `unknown`（platform-sdk 不依赖 elysia），收窄只能在包内做一次——`web` 槽
 * 的控制面路由需要会话守卫（`WorkflowV2RouteDependencies`）。这里不做校验：端口是否可用由宿主在装配处
 * 保证（`apps/server/src/bootstrap/route-host.ts` 是唯一实现）。
 *
 * 导出的是**构造函数**而不是实例：Elysia 的 macro / state 是实例作用域的，路由必须在宿主 app 构造前
 * 完成构造，构造时机由宿主装配决定，故本文件不持有任何状态。
 *
 * 三条工厂的声明序即挂载序（冻结 §2.1）：`bff` 必须排在静态反代之前——`/workflow-canvas/*` 是通配路由，
 * 挂载靠后才不会吞掉 `/workflow-canvas/bff/*`。
 *
 * 两条 `app` 槽工厂不消费 host（形参以 `_` 前缀标注）：`bff` 的凭据是请求头票据，静态资源是同源 iframe
 * 的公开资产，二者都没有会话守卫可注入；保留形参是为了与冻结 §2.1 声明的工厂形状一致，也让 host 面
 * 将来真需要端口时不必改 manifest 的取值表达式。
 */

/** 把宿主协议面收窄为本包控制面路由的依赖。 */
function routeDependencies(host: ServerRouteHost): WorkflowV2RouteDependencies {
  return { authGuardPlugin: host.authGuardPlugin as AnyElysia };
}

/** `/web/workflow-v2/*` 控制台面（挂宿主 `web` 聚合槽，带会话守卫）。 */
export function createWorkflowV2WebRoutes(host: ServerRouteHost) {
  return createWebWorkflowV2Routes(routeDependencies(host));
}

/** `/workflow-canvas/bff/*` 画布透传面（挂宿主 `app` 槽，票据鉴权，无会话守卫）。 */
export function createWorkflowV2CanvasBffRoutes(_host: ServerRouteHost) {
  return createCanvasBffRoutes();
}

/** `/workflow-canvas/*` 画布静态反代（挂宿主 `app` 槽，无会话守卫）。 */
export function createWorkflowV2CanvasStaticRoutes(_host: ServerRouteHost) {
  return createCanvasStaticRoutes();
}
