import type { ServerRouteHost } from "@fenix/platform-sdk/server";
import type { AnyElysia } from "elysia";
import type { UserAgentPreferencesPort } from "./ports/user-agent-preferences";
import { createAgentSitesCompatRoutes, createAgentSitesProxyRoutes } from "./routes/agent-sites-proxy";
import { createApiAgentsRoutes } from "./routes/api/agents";
import type {
  ApiAgentConfigRouteDependencies,
  AuthenticateSiteRequest,
  SiteRequestIdentity,
  WebAgentConfigRouteDependencies,
  WebConfigAgentsRouteDependencies,
} from "./routes/dependencies";
import { createWebAgentGenerationRoutes } from "./routes/web/agent-generation";
import { createWebAgentSitesRoutes } from "./routes/web/agent-sites";
import { createWebConfigAgentsRoutes } from "./routes/web/config/agents";
import { createWebSidebarConfigRoutes } from "./routes/web/sidebar-config";

/**
 * Agent 配置的路由贡献装配面：把宿主协议面收窄为本包路由的注入依赖。
 *
 * `ServerRouteHost` 的字段全是 `unknown`（platform-sdk 不依赖 elysia，见 review §3.3），收窄只能在包内做
 * 一次。本包除会话守卫外还用到 Agent 级用户偏好端口（`user_config` 表的 owner 是 `@fenix/identity`，
 * 包内不直读）。`/web/sidebar-config` 无依赖——登录页也要用它，
 * 刻意不声明 `sessionAuth`。站点代理（`/web/site/deploy/*` 与 `/app-*` 兜底）另需请求级认证函数而非
 * 守卫：它要区分「未登录」与「已登录但无权限」并分别重定向，故由 `siteAuthenticator` 把宿主的
 * `authenticateRequest` 投影成 `SiteRequestIdentity`（只取 userId / organizationId 两个标识）。这里不做
 * 校验：端口是否可用由宿主在装配处保证（`apps/server/src/bootstrap/route-host.ts` 是唯一实现）。
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

/** `/web/agent-generation` Agent 生成（挂宿主 `web` 聚合槽）。 */
export function createAgentConfigWebAgentGenerationRoutes(host: ServerRouteHost) {
  const deps: WebAgentConfigRouteDependencies = { authGuardPlugin: authGuard(host) };
  return createWebAgentGenerationRoutes(deps);
}

/** `/api/agents` 对外稳定 Agent 接口（挂宿主 `api` 聚合槽）。 */
export function createAgentConfigApiRoutes(host: ServerRouteHost) {
  const deps: ApiAgentConfigRouteDependencies = { authGuardPlugin: authGuard(host) };
  return createApiAgentsRoutes(deps);
}

/**
 * 宿主认证结果中本包可见的结构：只取 `authContext` 上的两个标识。
 *
 * 不 import 宿主的 `RequestAuthResult` / `AuthContext`——包侧只判定「这个请求属于谁、在哪个组织」，
 * 把宿主认证对象整体搬进来会让包跟着宿主的上下文结构一起演进（理由见
 * `routes/dependencies.ts` 的 `SiteRequestIdentity`）。这里是收窄而非校验：端口由宿主保证。
 */
type HostAuthResult = { readonly authContext?: SiteRequestIdentity | null } | null;

/** 把宿主的 `authenticateRequest` 投影为站点代理需要的 `SiteRequestIdentity`。 */
function siteAuthenticator(host: ServerRouteHost): AuthenticateSiteRequest {
  const authenticateRequest = host.authenticateRequest as (request: Request) => Promise<HostAuthResult>;
  return async (request) => {
    const authContext = (await authenticateRequest(request))?.authContext;
    if (!authContext) return null;
    return { userId: authContext.userId, organizationId: authContext.organizationId };
  };
}

/** `/web/site/deploy/:appId/*` 站点应用代理（挂宿主 `app` 槽）。 */
export function createAgentConfigAgentSitesProxyRoutes(host: ServerRouteHost) {
  return createAgentSitesProxyRoutes({ authenticateRequest: siteAuthenticator(host) });
}

/**
 * `/app-*` 绝对路径兜底代理（挂宿主 `app` 槽）。
 *
 * 通配 `/*` 的匹配优先级低于任何具体路由，声明处写大 `order` 自证必须最后挂（`ModuleContribution.order`
 * 的既定用途）；宿主因此不维护「谁必须最后挂」的清单。
 */
export function createAgentConfigAgentSitesCompatRoutes(host: ServerRouteHost) {
  return createAgentSitesCompatRoutes({ authenticateRequest: siteAuthenticator(host) });
}
