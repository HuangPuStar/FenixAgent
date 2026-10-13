import type { ServerRouteHost } from "@fenix/platform-sdk/server";
import type { AnyElysia } from "elysia";
import { createApiMcpRoutes } from "./routes/api/mcp";
import type { McpRouteDependencies } from "./routes/dependencies";
import knowledgeMcpRoutes from "./routes/mcp/knowledge";
import { createWebMcpConfigRoutes } from "./routes/web/config/mcp";

/**
 * MCP 的路由贡献装配面：把宿主协议面收窄为本包路由的注入依赖。
 *
 * `ServerRouteHost` 的字段全是 `unknown`（platform-sdk 不依赖 elysia，见 review §3.3），收窄只能在包内做
 * 一次——本包的路由工厂需要的是 `McpRouteDependencies` 里的会话守卫。这里不做校验：端口是否可用由宿主在
 * 装配处保证（`apps/server/src/bootstrap/route-host.ts` 是唯一实现）。
 *
 * 导出的是**构造函数**而不是实例：Elysia 的 macro / state 是实例作用域的，路由必须在宿主 app 构造前完成
 * 构造，构造时机由宿主装配决定，故本文件不持有任何状态。
 */

/** 把宿主协议面收窄为本包路由的依赖。 */
function routeDependencies(host: ServerRouteHost): McpRouteDependencies {
  return { authGuardPlugin: host.authGuardPlugin as AnyElysia };
}

/** `/web/config/mcp` MCP 服务器管理（挂宿主 `web-config` 聚合槽）。 */
export function createMcpWebConfigRoutes(host: ServerRouteHost) {
  return createWebMcpConfigRoutes(routeDependencies(host));
}

/** `/api/mcp` 对外稳定 MCP 服务器接口（挂宿主 `api` 聚合槽）。 */
export function createMcpApiRoutes(host: ServerRouteHost) {
  return createApiMcpRoutes(routeDependencies(host));
}

/**
 * `/mcp/knowledge` 内部协议入口（挂宿主 `app` 槽）。
 *
 * 返回的是模块级单例而不是新构造的实例：这条路由用 Bearer environment secret 自鉴权（解析出的
 * environment 决定可见知识库），没有宿主守卫可注入，因此包内没有第二条实例（见
 * `routes/mcp/knowledge.ts` 的 `export default app`）。装配面仍以「函数」形态给出——贡献的 `value` 必须
 * 是惰性构造函数，这里只是把既有实例包一层，不复制第二份。
 */
export function createKnowledgeMcpAppRoutes() {
  return knowledgeMcpRoutes;
}
