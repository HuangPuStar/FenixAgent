import type { ServerRouteHost } from "@fenix/platform-sdk/server";
import type { AnyElysia } from "elysia";
import { createChannelSystemApiRoutes } from "./routes/api/system-channels";
import type { ChannelSystemApiRouteDependencies, ChannelWebRouteDependencies } from "./routes/dependencies";
import { createLangBotHookRoutes } from "./routes/hooks/langbot";
import { createImMcpRoutes } from "./routes/mcp/im";
import { createLangBotWebRoutes } from "./routes/web/langbot";

/**
 * Channel 的路由贡献装配面：把宿主协议面收窄为本包路由的注入依赖。
 *
 * `ServerRouteHost` 的字段全是 `unknown`（platform-sdk 不依赖 elysia），收窄只能在这里做一次。本包用到的
 * 两个守卫分属两种凭据：`/web` 面是会话守卫，`/api/system` 面是系统 key 守卫；Agent 配置可用性经端口在
 * 启动期绑定，不走这个宿主面。
 *
 * 导出的是**构造函数**而不是实例：Elysia 的 macro / state 是实例作用域的，路由必须在宿主 app 构造前完成
 * 构造，构造时机由宿主装配决定，故本文件不持有任何状态。
 */

/** `/web/channels/langbot`（挂宿主 `web` 聚合槽）。 */
export function createChannelLangBotWebRoutes(host: ServerRouteHost) {
  const deps: ChannelWebRouteDependencies = { authGuardPlugin: host.authGuardPlugin as AnyElysia };
  return createLangBotWebRoutes(deps);
}

/**
 * `/api/system/channels`（挂宿主 `api` 聚合槽）。
 *
 * 收窄的是系统 key 守卫而不是会话守卫：admin 页面用 `RCS_SYSTEM_API_KEYS` 认证，没有登录会话，也没有
 * active organization。路径自带 `/api/system` 前缀（对外合同的一部分），前缀不由宿主拼接。
 */
export function createChannelApiSystemRoutes(host: ServerRouteHost) {
  const deps: ChannelSystemApiRouteDependencies = { systemApiGuardPlugin: host.systemApiGuardPlugin as AnyElysia };
  return createChannelSystemApiRoutes(deps);
}

/**
 * `/hooks/langbot/:channelId`（挂宿主顶层 `app` 槽）。
 *
 * 工厂不消费 `ServerRouteHost`：无认证是 Webhook 的协议语义（channelId 即路径凭据），没有守卫可注入。
 */
export function createChannelLangBotHookRoutes() {
  return createLangBotHookRoutes();
}

/**
 * `/mcp/im`（挂宿主顶层 `app` 槽）。
 *
 * 与 Webhook 一样不消费 `ServerRouteHost`：认证凭据是 Bearer 连接 token，不是会话守卫；会话边界由
 * token 解析出的 conversation 决定。
 */
export function createChannelImMcpRoutes() {
  return createImMcpRoutes();
}
