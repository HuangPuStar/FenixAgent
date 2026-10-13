import type { ServerRouteHost } from "@fenix/platform-sdk/server";
import type { AnyElysia } from "elysia";
import type { SecretReferenceResolver } from "./config-envelope";
import type { UserModelPreferencesPort } from "./ports/user-model-preferences";
import { createApiModelsRoutes } from "./routes/api/models";
import { createApiSystemModelGatewayRoutes } from "./routes/api/system-model-gateway";
import type {
  ApiModelManagementRouteDependencies,
  EnvironmentOwnershipCheck,
  SystemApiModelManagementRouteDependencies,
  WebConfigModelsRouteDependencies,
  WebConfigProvidersRouteDependencies,
  WebModelManagementRouteDependencies,
  WebPeriTaskDetailsRouteDependencies,
} from "./routes/dependencies";
import { createWebConfigModelsRoutes } from "./routes/web/config/models";
import { createWebConfigProvidersRoutes } from "./routes/web/config/providers";
import { createWebModelGatewayRoutes } from "./routes/web/model-gateway";
import { createWebPeriTaskDetailsRoutes } from "./routes/web/peri-task-details";

/**
 * Model 管理的路由贡献装配面：把宿主协议面收窄为本包路由的注入依赖。
 *
 * `ServerRouteHost` 的字段全是 `unknown`（platform-sdk 不依赖 elysia，见 review §3.3），收窄只能在包内做
 * 一次——本包除会话守卫外还需要模型级用户偏好端口、密钥引用解析（`user_config` 表的 owner 是
 * `@fenix/identity`，`{env:NAME}` 的真相来源是宿主进程环境，包内两件事都不能做）与 Environment 归属校验
 * （`Environment` 表的 owner 是 `@fenix/agent-runtime`，依赖矩阵不允许资源包依赖该包）。这里不做校验：
 * 端口是否可用由宿主在装配处保证（`apps/server/src/bootstrap/route-host.ts` 是唯一实现）。
 *
 * 导出的是**构造函数**而不是实例：Elysia 的 macro / state 是实例作用域的，路由必须在宿主 app 构造前完成
 * 构造，构造时机由宿主装配决定，故本文件不持有任何状态。
 */

/** 会话守卫收窄；本包 `/web/*` 路由与 `/api/models` 都要它。 */
function authGuard(host: ServerRouteHost): AnyElysia {
  return host.authGuardPlugin as AnyElysia;
}

/** 系统 API 守卫收窄；只有 `/api/system/model-gateway` 要它（与普通请求认证互不相关）。 */
function systemApiGuard(host: ServerRouteHost): AnyElysia {
  return host.systemApiGuardPlugin as AnyElysia;
}

/** `/web/config/models` 模型清单与同步（挂宿主 `web-config` 聚合槽）。 */
export function createModelManagementWebConfigModelsRoutes(host: ServerRouteHost) {
  const deps: WebConfigModelsRouteDependencies = {
    authGuardPlugin: authGuard(host),
    userModelPreferences: host.userModelPreferences as UserModelPreferencesPort,
  };
  return createWebConfigModelsRoutes(deps);
}

/** `/web/config/providers` 供应商配置（挂宿主 `web-config` 聚合槽）。 */
export function createModelManagementWebConfigProvidersRoutes(host: ServerRouteHost) {
  const deps: WebConfigProvidersRouteDependencies = {
    authGuardPlugin: authGuard(host),
    resolveSecretReference: host.resolveSecretReference as SecretReferenceResolver,
  };
  return createWebConfigProvidersRoutes(deps);
}

/** `/web/model-gateway` 网关供应商的模型用量（挂宿主 `web` 聚合槽）。 */
export function createModelManagementWebGatewayRoutes(host: ServerRouteHost) {
  const deps: WebModelManagementRouteDependencies = { authGuardPlugin: authGuard(host) };
  return createWebModelGatewayRoutes(deps);
}

/** `/web/agents/:environmentId/.../peri-tasks/:taskId/detail` Peri 任务详情（挂宿主 `web` 聚合槽）。 */
export function createModelManagementWebPeriTaskDetailsRoutes(host: ServerRouteHost) {
  const deps: WebPeriTaskDetailsRouteDependencies = {
    authGuardPlugin: authGuard(host),
    getOwnedEnvironment: host.verifyEnvironmentOwnership as EnvironmentOwnershipCheck,
  };
  return createWebPeriTaskDetailsRoutes(deps);
}

/** `/api/models` 对外稳定模型与供应商接口（挂宿主 `api` 聚合槽）。 */
export function createModelManagementApiModelsRoutes(host: ServerRouteHost) {
  const deps: ApiModelManagementRouteDependencies = { authGuardPlugin: authGuard(host) };
  return createApiModelsRoutes(deps);
}

/** `/api/system/model-gateway` 系统管理网关接口（挂宿主 `api` 聚合槽）。 */
export function createModelManagementApiSystemModelGatewayRoutes(host: ServerRouteHost) {
  const deps: SystemApiModelManagementRouteDependencies = { systemApiGuardPlugin: systemApiGuard(host) };
  return createApiSystemModelGatewayRoutes(deps);
}
