import type { ServerRouteHost } from "@fenix/platform-sdk/server";
import type { AnyElysia } from "elysia";
import type { ChannelEnvironmentLookup, WebChannelRouteDependencies } from "./routes/dependencies";
import { createWebChannelsRoutes } from "./routes/web/channels";

/**
 * Channel 的路由贡献装配面：把宿主协议面收窄为本包路由的注入依赖。
 *
 * `ServerRouteHost` 的字段全是 `unknown`（platform-sdk 不依赖 elysia，见 review §3.3），收窄只能在包内做
 * 一次——本包除会话守卫外还需要 Environment 归属查询（`Environment` 表的 owner 是 `@fenix/agent-runtime`，
 * 包内不得依赖它）。这里不做校验：端口是否可用由宿主在装配处保证
 * （`apps/server/src/bootstrap/route-host.ts` 是唯一实现）。
 *
 * 导出的是**构造函数**而不是实例：Elysia 的 macro / state 是实例作用域的，路由必须在宿主 app 构造前完成
 * 构造，构造时机由宿主装配决定，故本文件不持有任何状态。
 */

/** 把宿主协议面收窄为本包路由的依赖。 */
function routeDependencies(host: ServerRouteHost): WebChannelRouteDependencies {
  return {
    authGuardPlugin: host.authGuardPlugin as AnyElysia,
    environmentLookup: host.environmentLookup as ChannelEnvironmentLookup,
  };
}

/** `/web/channels` 通道提供商与绑定管理（挂宿主 `web` 聚合槽）。 */
export function createChannelWebRoutes(host: ServerRouteHost) {
  return createWebChannelsRoutes(routeDependencies(host));
}
