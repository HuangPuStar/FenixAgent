import type { ServerRouteHost } from "@fenix/platform-sdk/server";
import type { AnyElysia } from "elysia";
import { createApiSystemLogsRoutes } from "./routes/api/system-logs";
import { createApiSystemObserverRoutes } from "./routes/api/system-observer";
import { createApiSystemPeopleTreeRoutes } from "./routes/api/system-people-tree";
import type { SystemApiObserverRouteDependencies } from "./routes/dependencies";

/**
 * Observer 的路由贡献装配面：把宿主协议面收窄为本包路由的注入依赖。
 *
 * `ServerRouteHost` 的字段全是 `unknown`（platform-sdk 不依赖 elysia，见 review §3.3），收窄只能在包内做
 * 一次——本包三条路由都受系统 API Key 保护，需要的是 `SystemApiObserverRouteDependencies` 里的系统 API
 * 守卫（与普通请求认证互不相关）。这里不做校验：端口是否可用由宿主在装配处保证
 * （`apps/server/src/bootstrap/route-host.ts` 是唯一实现）。
 *
 * 导出的是**构造函数**而不是实例：Elysia 的 macro / state 是实例作用域的，路由必须在宿主 app 构造前完成
 * 构造，构造时机由宿主装配决定，故本文件不持有任何状态。
 */

/** 把宿主协议面收窄为本包路由的依赖。 */
function routeDependencies(host: ServerRouteHost): SystemApiObserverRouteDependencies {
  return { systemApiGuardPlugin: host.systemApiGuardPlugin as AnyElysia };
}

/** `/api/system/observer/*` 运行中 ACP 链接的只读观察面（挂宿主 `api` 聚合槽）。 */
export function createObserverApiSystemRoutes(host: ServerRouteHost) {
  return createApiSystemObserverRoutes(routeDependencies(host));
}

/** `/api/system/logs` 系统日志列举、检索与下载（挂宿主 `api` 聚合槽）。 */
export function createObserverApiSystemLogsRoutes(host: ServerRouteHost) {
  return createApiSystemLogsRoutes(routeDependencies(host));
}

/** `/api/system/people-tree` 组织 → 成员 → 智能体配置人员树（挂宿主 `api` 聚合槽）。 */
export function createObserverApiSystemPeopleTreeRoutes(host: ServerRouteHost) {
  return createApiSystemPeopleTreeRoutes(routeDependencies(host));
}
