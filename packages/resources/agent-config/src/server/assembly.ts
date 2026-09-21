import type { ServerRouteHost } from "@fenix/platform-sdk/server";
import type { AnyElysia } from "elysia";
import type { UserAgentPreferencesPort } from "./ports/user-agent-preferences";
import type {
  WebAgentConfigRouteDependencies,
  WebConfigAgentsRouteDependencies,
  WebMetaAgentRouteDependencies,
} from "./routes/dependencies";
import { createWebAgentGenerationRoutes } from "./routes/web/agent-generation";
import { createWebAgentSitesRoutes } from "./routes/web/agent-sites";
import { createWebConfigAgentsRoutes } from "./routes/web/config/agents";
import { createWebMetaAgentRoutes } from "./routes/web/meta-agent";
import { createWebSidebarConfigRoutes } from "./routes/web/sidebar-config";
import type { RotateCallerApiKey } from "./services/meta-agent";

/**
 * Agent 配置的路由贡献装配面：把宿主协议面收窄为本包路由的注入依赖。
 *
 * `ServerRouteHost` 的字段全是 `unknown`（platform-sdk 不依赖 elysia，见 review §3.3），收窄只能在包内做
 * 一次。本包除会话守卫外用到两个端口：Agent 级用户偏好（`user_config` 表的 owner 是 `@fenix/identity`，
 * 包内不直读）与调用方 API Key 轮换（`apikey` 表同上）。`/web/sidebar-config` 无依赖——登录页也要用它，
 * 刻意不声明 `sessionAuth`。这里不做校验：端口是否可用由宿主在装配处保证
 * （`apps/server/src/bootstrap/route-host.ts` 是唯一实现）。
 *
 * 导出的是**构造函数**而不是实例：Elysia 的 macro / state 是实例作用域的，路由必须在宿主 app 构造前完成
 * 构造，构造时机由宿主装配决定，故本文件不持有任何状态。
 */

/** 会话守卫收窄；除 `/web/sidebar-config` 外的本包路由都要它。 */
function authGuard(host: ServerRouteHost): AnyElysia {
  return host.authGuardPlugin as AnyElysia;
}

/** `/web/config/agents` 的依赖：会话守卫 + Agent 级用户偏好端口。 */
function configAgentsDependencies(host: ServerRouteHost): WebConfigAgentsRouteDependencies {
  return {
    authGuardPlugin: authGuard(host),
    userAgentPreferences: host.userAgentPreferences as UserAgentPreferencesPort,
  };
}

/** `/web/config/agents` Agent 模板与默认 Agent 配置（挂宿主 `web-config` 聚合槽）。 */
export function createAgentConfigWebConfigRoutes(host: ServerRouteHost) {
  return createWebConfigAgentsRoutes(configAgentsDependencies(host));
}

/** `/web/sidebar-config` 公开展示配置（挂宿主 `web` 聚合槽）。工厂无依赖：登录页也要用它。 */
export function createAgentConfigWebSidebarConfigRoutes() {
  return createWebSidebarConfigRoutes();
}

/** `/web/agent-sites` 站点 App（挂宿主 `web` 聚合槽）。 */
export function createAgentConfigWebAgentSitesRoutes(host: ServerRouteHost) {
  const deps: WebAgentConfigRouteDependencies = { authGuardPlugin: authGuard(host) };
  return createWebAgentSitesRoutes(deps);
}

/** `/web/meta-agent/ensure` meta environment 拉起与 API Key 轮换（挂宿主 `web` 聚合槽）。 */
export function createAgentConfigWebMetaAgentRoutes(host: ServerRouteHost) {
  const deps: WebMetaAgentRouteDependencies = {
    authGuardPlugin: authGuard(host),
    rotateCallerApiKey: host.rotateCallerApiKey as RotateCallerApiKey,
  };
  return createWebMetaAgentRoutes(deps);
}

/** `/web/agent-generation` Agent 生成（挂宿主 `web` 聚合槽）。 */
export function createAgentConfigWebAgentGenerationRoutes(host: ServerRouteHost) {
  const deps: WebAgentConfigRouteDependencies = { authGuardPlugin: authGuard(host) };
  return createWebAgentGenerationRoutes(deps);
}
