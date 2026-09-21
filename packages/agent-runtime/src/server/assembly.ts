import type { ServerRouteHost } from "@fenix/platform-sdk/server";
import type { AnyElysia } from "elysia";
import { createApiInstanceRoutes } from "../routes/api/instances";
import { createOpenaiChatRoutes } from "../routes/api/openai-chat";
import type {
  AgentRuntimeAuthDependencies,
  ApiInstanceRouteDependencies,
  RequestErrorLogger,
} from "../routes/dependencies";
import { createWebControlRoutes } from "../routes/web/control";
import { createWebEnvironmentsRoutes } from "../routes/web/environments";
import { createWebInstancesRoutes } from "../routes/web/instances";

/**
 * agent-runtime 的路由贡献装配面：把宿主协议面收窄为本包路由的注入依赖。
 *
 * `ServerRouteHost` 的字段全是 `unknown`（platform-sdk 不依赖 elysia，见 review §3.3），收窄只能在包内做
 * 一次——本包的路由工厂需要的是 `AgentRuntimeAuthDependencies` 里的会话守卫，`/api/agents/:agentId/instances/connect`
 * 另需宿主请求错误日志。这里不做校验：端口是否可用由宿主在装配处保证
 * （`apps/server/src/bootstrap/route-host.ts` 是唯一实现）。
 *
 * 导出的是**构造函数**而不是实例：Elysia 的 macro / state 是实例作用域的，路由必须在宿主 app 构造前完成
 * 构造，构造时机由宿主装配决定，故本文件不持有任何状态。
 */

/** 把宿主协议面收窄为本包路由的依赖。 */
function routeDependencies(host: ServerRouteHost): AgentRuntimeAuthDependencies {
  return { authGuardPlugin: host.authGuardPlugin as AnyElysia };
}

/** `/web/control` 实例控制面（挂宿主 `web` 聚合槽）。 */
export function createAgentRuntimeWebControlRoutes(host: ServerRouteHost) {
  return createWebControlRoutes(routeDependencies(host));
}

/** `/web/environments` 环境管理（挂宿主 `web` 聚合槽）。 */
export function createAgentRuntimeWebEnvironmentsRoutes(host: ServerRouteHost) {
  return createWebEnvironmentsRoutes(routeDependencies(host));
}

/** `/web/instances` 持久实例管理（挂宿主 `web` 聚合槽）。 */
export function createAgentRuntimeWebInstancesRoutes(host: ServerRouteHost) {
  return createWebInstancesRoutes(routeDependencies(host));
}

/** `/api/agents/:agentId/instances/connect` 实例接入（挂宿主 `api` 聚合槽）。 */
export function createAgentRuntimeApiInstanceRoutes(host: ServerRouteHost) {
  const deps: ApiInstanceRouteDependencies = {
    authGuardPlugin: host.authGuardPlugin as AnyElysia,
    logError: host.logError as RequestErrorLogger,
  };
  return createApiInstanceRoutes(deps);
}

/** `/api/agents/:agentId/v1/chat/completions` OpenAI 兼容对话（挂宿主 `api` 聚合槽）。 */
export function createAgentRuntimeOpenaiChatRoutes(host: ServerRouteHost) {
  return createOpenaiChatRoutes(routeDependencies(host));
}
