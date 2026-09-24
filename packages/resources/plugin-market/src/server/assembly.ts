import type { ServerRouteHost } from "@fenix/platform-sdk/server";
import type { AnyElysia } from "elysia";
import { createApiSystemPluginMarketRoutes } from "./routes/api/system-plugin-market";
import type { PluginMarketRouteDependencies } from "./routes/dependencies";
import { createWebPluginMarketConfigRoutes } from "./routes/web/config/plugin-market";

/**
 * 插件市场的路由贡献装配面：把宿主协议面收窄为本包路由的注入依赖。
 *
 * `ServerRouteHost` 的字段全是 `unknown`（platform-sdk 不依赖 elysia），收窄只能在包内做一次——本包两条面
 * 各需一道门：浏览面要会话守卫，管理面要系统 API 守卫。这里不做校验：端口是否可用由宿主在装配处保证
 * （`apps/server/src/bootstrap/route-host.ts` 是唯一实现）。
 *
 * 导出的是**构造函数**而不是实例：`sessionAuth` / `systemApiKeyAuth` 宏与 `store.actor` 由宿主守卫写入，
 * Elysia 的 `macro` / `state` 是实例作用域的，子实例必须在宿主 app 构造前完成构造，构造时机由宿主装配决定，
 * 故本文件不持有任何状态。
 *
 * 两条贡献（`web-config` 与 `api` 两个槽）：市场是**浏览 + 平台管理**两件事——浏览面对任意已认证主体开放，
 * 管理面（发布、下架、恢复）只认系统 API Key，因为「谁能管理市场」的判据是凭据而不是会话角色。
 * 市场没有面向外部系统的 `/api` 面，也没有自鉴权的内部协议入口。
 */

/** 把宿主协议面收窄为本包路由的依赖。 */
function routeDependencies(host: ServerRouteHost): PluginMarketRouteDependencies {
  return {
    authGuardPlugin: host.authGuardPlugin as AnyElysia,
    systemApiGuardPlugin: host.systemApiGuardPlugin as AnyElysia,
  };
}

/** `/web/config/plugin-market/*` 插件市场浏览面（挂宿主 `web-config` 聚合槽）。 */
export function createPluginMarketWebConfigRoutes(host: ServerRouteHost) {
  return createWebPluginMarketConfigRoutes(routeDependencies(host));
}

/** `/api/system/plugin-market/*` 插件市场管理面（挂宿主 `api` 聚合槽）。 */
export function createPluginMarketApiSystemRoutes(host: ServerRouteHost) {
  return createApiSystemPluginMarketRoutes(routeDependencies(host));
}
