import type { ServerRouteHost } from "@fenix/platform-sdk/server";
import type { AnyElysia } from "elysia";
import type { KnowledgeRouteDependencies } from "./routes/dependencies";
import { createWebKnowledgeBaseRoutes } from "./routes/web/knowledge-bases";

/**
 * Knowledge 的路由贡献装配面：把宿主协议面收窄为本包路由的注入依赖。
 *
 * `ServerRouteHost` 的字段全是 `unknown`（platform-sdk 不依赖 elysia，见 review §3.3），收窄只能在包内做
 * 一次——本包的路由工厂需要的是 `KnowledgeRouteDependencies` 里的会话守卫。这里不做校验：端口是否可用由
 * 宿主在装配处保证（`apps/server/src/bootstrap/route-host.ts` 是唯一实现）。
 *
 * 导出的是**构造函数**而不是实例：Elysia 的 macro / state 是实例作用域的，路由必须在宿主 app 构造前完成
 * 构造，构造时机由宿主装配决定，故本文件不持有任何状态。
 */

/** 把宿主协议面收窄为本包路由的依赖。 */
function routeDependencies(host: ServerRouteHost): KnowledgeRouteDependencies {
  return { authGuardPlugin: host.authGuardPlugin as AnyElysia };
}

/** `/web/knowledge-bases` 知识库管理（挂宿主 `web` 聚合槽）。 */
export function createKnowledgeWebRoutes(host: ServerRouteHost) {
  return createWebKnowledgeBaseRoutes(routeDependencies(host));
}
