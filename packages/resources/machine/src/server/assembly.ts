import type { ServerRouteHost } from "@fenix/platform-sdk/server";
import type { AnyElysia } from "elysia";
import { createApiWorkspaceRoutes } from "./routes/api/workspaces";
import type { WebFileEventsRouteDependencies, WebMachineRouteDependencies } from "./routes/dependencies";
import { createWebFileEventsRoutes } from "./routes/web/file-events";
import { createWebFsRoutes } from "./routes/web/fs";
import { createWebRegistryRoutes } from "./routes/web/registry";

/**
 * Machine 的路由贡献装配面：把宿主协议面收窄为本包路由的注入依赖。
 *
 * `ServerRouteHost` 的字段全是 `unknown`（platform-sdk 不依赖 elysia，见 review §3.3），收窄只能在包内做
 * 一次——三条路由需要会话守卫，其中 `/web/file-events` 是 WS 升级、不经过 `sessionAuth` 宏，改为直接调用
 * 宿主的显式认证入口（与守卫同源，否则 WS 会用另一套解析规则判定身份）。这里不做校验：端口是否可用由
 * 宿主在装配处保证（`apps/server/src/bootstrap/route-host.ts` 是唯一实现）。
 *
 * 导出的是**构造函数**而不是实例：Elysia 的 macro / state 是实例作用域的，路由必须在宿主 app 构造前完成
 * 构造，构造时机由宿主装配决定，故本文件不持有任何状态。
 */

/** 把宿主协议面收窄为需要会话守卫的两条路由的依赖。 */
function routeDependencies(host: ServerRouteHost): WebMachineRouteDependencies {
  return { authGuardPlugin: host.authGuardPlugin as AnyElysia };
}

/** `/web/environments/:id/files/*` 文件浏览与读写（挂宿主 `web` 聚合槽）。 */
export function createMachineWebFsRoutes(host: ServerRouteHost) {
  return createWebFsRoutes(routeDependencies(host));
}

/** `/web/file-events` 文件变更事件 WebSocket（挂宿主 `web` 聚合槽）。 */
export function createMachineWebFileEventsRoutes(host: ServerRouteHost) {
  const deps: WebFileEventsRouteDependencies = {
    authenticateRequest: host.authenticateRequest as WebFileEventsRouteDependencies["authenticateRequest"],
  };
  return createWebFileEventsRoutes(deps);
}

/** `/web/machines` 机器注册表管理（挂宿主 `web` 聚合槽）。 */
export function createMachineWebRegistryRoutes(host: ServerRouteHost) {
  return createWebRegistryRoutes(routeDependencies(host));
}

/** `/api/environments/:environmentId/workspace/files` 对外工作区文件接口（挂宿主 `api` 聚合槽）。 */
export function createMachineApiWorkspaceRoutes(host: ServerRouteHost) {
  return createApiWorkspaceRoutes(routeDependencies(host));
}
