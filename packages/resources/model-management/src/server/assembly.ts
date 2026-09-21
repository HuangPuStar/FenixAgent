import type { ServerRouteHost } from "@fenix/platform-sdk/server";
import type { AnyElysia } from "elysia";
import type { SecretReferenceResolver } from "./config-envelope";
import type { UserModelPreferencesPort } from "./ports/user-model-preferences";
import type { WebConfigModelsRouteDependencies, WebConfigProvidersRouteDependencies } from "./routes/dependencies";
import { createWebConfigModelsRoutes } from "./routes/web/config/models";
import { createWebConfigProvidersRoutes } from "./routes/web/config/providers";

/**
 * Model 管理的路由贡献装配面：把宿主协议面收窄为本包路由的注入依赖。
 *
 * `ServerRouteHost` 的字段全是 `unknown`（platform-sdk 不依赖 elysia，见 review §3.3），收窄只能在包内做
 * 一次——本包除会话守卫外还需要模型级用户偏好端口与密钥引用解析（`user_config` 表的 owner 是
 * `@fenix/identity`，`{env:NAME}` 的真相来源是宿主进程环境，包内两件事都不能做）。这里不做校验：端口
 * 是否可用由宿主在装配处保证（`apps/server/src/bootstrap/route-host.ts` 是唯一实现）。
 *
 * 导出的是**构造函数**而不是实例：Elysia 的 macro / state 是实例作用域的，路由必须在宿主 app 构造前完成
 * 构造，构造时机由宿主装配决定，故本文件不持有任何状态。
 */

/** 两条 `/web/config/*` 路由共用的收窄。 */
function authGuard(host: ServerRouteHost): AnyElysia {
  return host.authGuardPlugin as AnyElysia;
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
