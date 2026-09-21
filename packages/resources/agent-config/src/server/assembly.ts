import type { ServerRouteHost } from "@fenix/platform-sdk/server";
import type { AnyElysia } from "elysia";
import type { UserAgentPreferencesPort } from "./ports/user-agent-preferences";
import type { WebConfigAgentsRouteDependencies } from "./routes/dependencies";
import { createWebConfigAgentsRoutes } from "./routes/web/config/agents";

/**
 * Agent 配置的路由贡献装配面：把宿主协议面收窄为本包路由的注入依赖。
 *
 * `ServerRouteHost` 的字段全是 `unknown`（platform-sdk 不依赖 elysia，见 review §3.3），收窄只能在包内做
 * 一次——本包需要会话守卫与 Agent 级用户偏好端口（`user_config` 表的 owner 是 `@fenix/identity`，包内
 * 不直读）。这里不做校验：端口是否可用由宿主在装配处保证（`apps/server/src/bootstrap/route-host.ts` 是
 * 唯一实现）。
 *
 * 导出的是**构造函数**而不是实例：Elysia 的 macro / state 是实例作用域的，路由必须在宿主 app 构造前完成
 * 构造，构造时机由宿主装配决定，故本文件不持有任何状态。
 */

/** 把宿主协议面收窄为本包路由的依赖。 */
function routeDependencies(host: ServerRouteHost): WebConfigAgentsRouteDependencies {
  return {
    authGuardPlugin: host.authGuardPlugin as AnyElysia,
    userAgentPreferences: host.userAgentPreferences as UserAgentPreferencesPort,
  };
}

/** `/web/config/agents` Agent 模板与默认 Agent 配置（挂宿主 `web-config` 聚合槽）。 */
export function createAgentConfigWebConfigRoutes(host: ServerRouteHost) {
  return createWebConfigAgentsRoutes(routeDependencies(host));
}
