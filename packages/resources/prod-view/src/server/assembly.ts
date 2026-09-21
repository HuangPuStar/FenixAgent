import type { ServerRouteHost } from "@fenix/platform-sdk/server";
import type { AnyElysia } from "elysia";
import type { WebProdViewRouteDependencies } from "./routes/dependencies";
import { createWebConfigProdViewsRoutes } from "./routes/web/config/prod-views";
import { createWebProdViewsRoutes } from "./routes/web/prod-views";

/**
 * ProdView 的路由贡献装配面：把宿主协议面收窄为本包路由的注入依赖。
 *
 * `ServerRouteHost` 的字段全是 `unknown`（platform-sdk 不依赖 elysia，见 review §3.3），收窄只能在包内
 * 做一次——本包的路由工厂需要的是 `WebProdViewRouteDependencies` 里的会话守卫。这里不做任何校验：
 * 端口是否可用由宿主在装配处保证（`apps/server/src/bootstrap/route-host.ts` 是唯一实现），本文件只表达
 * 「本包需要哪几个字段」，多一个字段都要在这里显式出现。
 *
 * 导出的是**构造函数**而不是实例：路由必须在宿主 app 构造前完成构造（Elysia 的 macro / state 是实例
 * 作用域的），构造时机由宿主装配决定，故本文件不持有任何状态。
 */

/** 把宿主协议面收窄为本包路由的依赖；多字段的收窄理由见文件头。 */
function routeDependencies(host: ServerRouteHost): WebProdViewRouteDependencies {
  return { authGuardPlugin: host.authGuardPlugin as AnyElysia };
}

/** `/web/prod-views/*` 公开读取路由（挂宿主 `web` 聚合槽）。 */
export function createProdViewWebRoutes(host: ServerRouteHost) {
  return createWebProdViewsRoutes(routeDependencies(host));
}

/** `/web/config/prod-views` 管理 CRUD（挂宿主 `web-config` 聚合槽）。 */
export function createProdViewWebConfigRoutes(host: ServerRouteHost) {
  return createWebConfigProdViewsRoutes(routeDependencies(host));
}
