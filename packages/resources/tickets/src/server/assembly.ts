import type { ServerRouteHost } from "@fenix/platform-sdk/server";
import type { AnyElysia } from "elysia";
import { createApiSystemTicketsRoutes } from "./routes/api/system-tickets";
import type { SystemApiTicketRouteDependencies, WebTicketRouteDependencies } from "./routes/dependencies";
import { createWebTicketRoutes } from "./routes/web";

/**
 * 工单的路由贡献装配面：把宿主协议面收窄为本包路由的注入依赖（照 `@fenix/resource-task/src/server/assembly.ts`
 * 与 `@fenix/resource-mcp/src/server/assembly.ts` 同形）。
 *
 * `ServerRouteHost` 的字段全是 `unknown`（platform-sdk 不依赖 elysia），收窄只能在包内做一次——本包两条贡献
 * 各需要一份依赖：`/web` 面要会话守卫，`/api/system` 面要系统 key 守卫（两者的认证状态互不相关）。这里不做
 * 校验：端口是否可用由宿主在装配处保证（`apps/server/src/bootstrap/route-host.ts` 是唯一实现）。
 *
 * 导出的是**构造函数**而不是实例：Elysia 的 macro / state 是实例作用域的，路由必须在宿主 app 构造前完成
 * 构造，构造时机由宿主装配决定，故本文件不持有任何状态（`fenix.module.ts` 的贡献 `value` 正是这些函数）。
 */

/** 把宿主协议面收窄为本包 `/web` 路由的依赖。 */
function routeDependencies(host: ServerRouteHost): WebTicketRouteDependencies {
  return { authGuardPlugin: host.authGuardPlugin as AnyElysia };
}

/** 把宿主协议面收窄为本包系统管理面路由的依赖。 */
function systemRouteDependencies(host: ServerRouteHost): SystemApiTicketRouteDependencies {
  return { systemApiGuardPlugin: host.systemApiGuardPlugin as AnyElysia };
}

/** `/web/ticket-projects*`、`/web/tickets*`、`/web/ticket-operations*`（挂宿主 `web` 聚合槽）。 */
export function createTicketsWebRoutes(host: ServerRouteHost) {
  return createWebTicketRoutes(routeDependencies(host));
}

/**
 * `/api/system/tickets` 平台管理面（跨组织列表、详情与写路径；挂宿主 `api` 聚合槽）。
 *
 * 路径自带 `/api/system` 前缀（对外合同的一部分），不由宿主拼接；能力清单见
 * `docs/arch/29-tickets.md` §12.1。
 */
export function createTicketsApiSystemTicketsRoutes(host: ServerRouteHost) {
  return createApiSystemTicketsRoutes(systemRouteDependencies(host));
}
