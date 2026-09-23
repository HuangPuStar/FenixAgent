import type { ServerRouteHost } from "@fenix/platform-sdk/server";
import type { AnyElysia } from "elysia";
import type { PluginMarketRouteDependencies } from "./routes/dependencies";
import { createWebPluginMarketConfigRoutes } from "./routes/web/config/plugin-market";

/**
 * 插件市场的路由贡献装配面：把宿主协议面收窄为本包路由的注入依赖。
 *
 * `ServerRouteHost` 的字段全是 `unknown`（platform-sdk 不依赖 elysia），收窄只能在包内做一次——本包路由
 * 工厂需要的是 `PluginMarketRouteDependencies` 里的会话守卫。这里不做校验：端口是否可用由宿主在装配处保证
 * （`apps/server/src/bootstrap/route-host.ts` 是唯一实现）。
 *
 * 导出的是**构造函数**而不是实例：`sessionAuth` 宏与 `store.actor` 由宿主守卫写入，Elysia 的 `macro` /
 * `state` 是实例作用域的，子实例必须在宿主 app 构造前完成构造，构造时机由宿主装配决定，故本文件不持有
 * 任何状态。
 *
 * 只有一条贡献（`web-config` 槽）：市场是纯控制台资源，没有对外 `/api` 面，也没有自鉴权的内部协议入口
 * ——发布与下架是平台管理动作，只能经控制台会话发生，不能由持有 API Key 的外部系统发起。
 */

/** 把宿主协议面收窄为本包路由的依赖。 */
function routeDependencies(host: ServerRouteHost): PluginMarketRouteDependencies {
  return { authGuardPlugin: host.authGuardPlugin as AnyElysia };
}

/** `/web/config/plugin-market/*` 插件市场控制台接口（挂宿主 `web-config` 聚合槽）。 */
export function createPluginMarketWebConfigRoutes(host: ServerRouteHost) {
  return createWebPluginMarketConfigRoutes(routeDependencies(host));
}
