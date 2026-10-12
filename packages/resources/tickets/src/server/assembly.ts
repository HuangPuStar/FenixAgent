import type { ServerRouteHost } from "@fenix/platform-sdk/server";
import type { AnyElysia } from "elysia";
import type { WebTicketRouteDependencies } from "./routes/dependencies";
import { createWebTicketRoutes } from "./routes/web";

/**
 * 工单的路由贡献装配面：把宿主协议面收窄为本包路由的注入依赖（照 `@fenix/resource-task/src/server/assembly.ts`
 * 与 `@fenix/resource-mcp/src/server/assembly.ts` 同形）。
 *
 * `ServerRouteHost` 的字段全是 `unknown`（platform-sdk 不依赖 elysia），收窄只能在包内做一次——本包路由
 * 需要的是 `WebTicketRouteDependencies` 里的会话守卫。这里不做校验：端口是否可用由宿主在装配处保证
 * （`apps/server/src/bootstrap/route-host.ts` 是唯一实现）。
 *
 * 导出的是**构造函数**而不是实例：Elysia 的 macro / state 是实例作用域的，路由必须在宿主 app 构造前完成
 * 构造，构造时机由宿主装配决定，故本文件不持有任何状态（`fenix.module.ts` 的贡献 `value` 正是这个函数）。
 */

/** 把宿主协议面收窄为本包路由的依赖。 */
function routeDependencies(host: ServerRouteHost): WebTicketRouteDependencies {
  return { authGuardPlugin: host.authGuardPlugin as AnyElysia };
}

/** `/web/ticket-projects*`、`/web/tickets*`、`/web/ticket-operations*`（挂宿主 `web` 聚合槽）。 */
export function createTicketsWebRoutes(host: ServerRouteHost) {
  return createWebTicketRoutes(routeDependencies(host));
}
