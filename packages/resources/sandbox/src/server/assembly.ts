import type { ServerRouteHost } from "@fenix/platform-sdk/server";
import type { AnyElysia } from "elysia";
import { createApiSandboxRoutes } from "./routes/api/sandbox";
import { createApiSandboxClusterRoutes } from "./routes/api/sandbox-cluster";
import { createApiSandboxServerRoutes } from "./routes/api/sandbox-server";
import type { SystemApiSandboxRouteDependencies, WebSandboxRouteDependencies } from "./routes/dependencies";
import { createWebSandboxPoolsRoutes } from "./routes/web/sandbox-pools";

/**
 * Sandbox 的路由贡献装配面：把宿主协议面收窄为本包路由的注入依赖。
 *
 * `ServerRouteHost` 的字段全是 `unknown`（platform-sdk 不依赖 elysia，见 review §3.3），收窄只能在包内做
 * 一次——本包的路由工厂需要的是 `WebSandboxRouteDependencies` 里的会话守卫，三条 `/api/system/*` 路由改用
 * `SystemApiSandboxRouteDependencies` 里的系统 API 守卫（两者互不相关，不共用一个收窄函数）。这里不做
 * 校验：端口是否可用由宿主在装配处保证（`apps/server/src/bootstrap/route-host.ts` 是唯一实现）。
 *
 * 导出的是**构造函数**而不是实例：Elysia 的 macro / state 是实例作用域的，路由必须在宿主 app 构造前完成
 * 构造，构造时机由宿主装配决定，故本文件不持有任何状态。
 */

/** 把宿主协议面收窄为 `/web/*` 路由的依赖。 */
function routeDependencies(host: ServerRouteHost): WebSandboxRouteDependencies {
  return { authGuardPlugin: host.authGuardPlugin as AnyElysia };
}

/** 把宿主协议面收窄为 `/api/system/*` 路由的依赖。 */
function systemApiDependencies(host: ServerRouteHost): SystemApiSandboxRouteDependencies {
  return { systemApiGuardPlugin: host.systemApiGuardPlugin as AnyElysia };
}

/** `/web/config/sandbox-pools` 沙箱池管理（挂宿主 `web-config` 聚合槽）。 */
export function createSandboxWebConfigRoutes(host: ServerRouteHost) {
  return createWebSandboxPoolsRoutes(routeDependencies(host));
}

/** `/api/system/sandbox-pools`、`/api/system/sandbox-instances` 沙箱池与实例（挂宿主 `api` 聚合槽）。 */
export function createSandboxApiRoutes(host: ServerRouteHost) {
  return createApiSandboxRoutes(systemApiDependencies(host));
}

/** `/api/system/sandbox-cluster` 集群管理（挂宿主 `api` 聚合槽）。 */
export function createSandboxApiClusterRoutes(host: ServerRouteHost) {
  return createApiSandboxClusterRoutes(systemApiDependencies(host));
}

/** `/api/system/sandbox-server` 沙箱服务端管理（挂宿主 `api` 聚合槽）。 */
export function createSandboxApiServerRoutes(host: ServerRouteHost) {
  return createApiSandboxServerRoutes(systemApiDependencies(host));
}
