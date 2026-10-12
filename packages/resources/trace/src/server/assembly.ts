import type { ServerRouteHost } from "@fenix/platform-sdk/server";
import type { AnyElysia } from "elysia";
import type { EnvironmentOwnershipCheck, WebTraceRouteDependencies } from "./routes/dependencies";
import { createWebTraceRoutes } from "./routes/web/traces";

/**
 * Trace 的路由贡献装配面：把宿主协议面收窄为本包路由的注入依赖。
 *
 * `ServerRouteHost` 的字段全是 `unknown`（platform-sdk 不依赖 elysia），收窄只能在包内做一次；这里不做
 * 校验——端口是否可用由宿主在装配处保证（`apps/server/src/bootstrap/route-host.ts` 是唯一实现）。
 *
 * 导出的是**构造函数**而不是实例：Elysia 的 macro / state 是实例作用域的，路由必须在宿主 app 构造前完成
 * 构造，构造时机由宿主装配决定，故本文件不持有任何状态。
 */

/** 把宿主协议面收窄为本包路由的依赖。 */
function routeDependencies(host: ServerRouteHost): WebTraceRouteDependencies {
  return {
    authGuardPlugin: host.authGuardPlugin as AnyElysia,
    getOwnedEnvironment: host.verifyEnvironmentOwnership as EnvironmentOwnershipCheck,
  };
}

/** `/web/agents/:environmentId/sessions/:sessionId/traces*` 会话观测只读接口（挂宿主 `web` 聚合槽）。 */
export function createTraceWebRoutes(host: ServerRouteHost) {
  return createWebTraceRoutes(routeDependencies(host));
}
