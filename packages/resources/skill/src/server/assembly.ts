import type { ServerRouteHost } from "@fenix/platform-sdk/server";
import type { AnyElysia } from "elysia";
import { createApiSkillsRoutes } from "./routes/api/skills";
import type { SkillRouteDependencies } from "./routes/dependencies";
import { skillDownloadRoutes } from "./routes/skills";
import { createWebSkillsConfigRoutes } from "./routes/web/config/skills";

/**
 * Skill 的路由贡献装配面：把宿主协议面收窄为本包路由的注入依赖。
 *
 * `ServerRouteHost` 的字段全是 `unknown`（platform-sdk 不依赖 elysia，见 review §3.3），收窄只能在包内做
 * 一次——本包的路由工厂需要的是 `SkillRouteDependencies` 里的会话守卫。这里不做校验：端口是否可用由宿主
 * 在装配处保证（`apps/server/src/bootstrap/route-host.ts` 是唯一实现）。
 *
 * 导出的是**构造函数**而不是实例：Elysia 的 macro / state 是实例作用域的，路由必须在宿主 app 构造前完成
 * 构造，构造时机由宿主装配决定，故本文件不持有任何状态。
 */

/** 把宿主协议面收窄为本包路由的依赖。 */
function routeDependencies(host: ServerRouteHost): SkillRouteDependencies {
  return { authGuardPlugin: host.authGuardPlugin as AnyElysia };
}

/** `/web/config/skills` 技能管理（挂宿主 `web-config` 聚合槽）。 */
export function createSkillWebConfigRoutes(host: ServerRouteHost) {
  return createWebSkillsConfigRoutes(routeDependencies(host));
}

/** `/api/skills` 对外稳定技能接口（挂宿主 `api` 聚合槽）。 */
export function createSkillApiRoutes(host: ServerRouteHost) {
  return createApiSkillsRoutes(routeDependencies(host));
}

/**
 * `/skills/:name/download` 归档下载（挂宿主 `app` 槽）。
 *
 * 返回的是模块级单例而不是新构造的实例：这条路由**不是工厂**（令牌本身就是授权凭据，无守卫可注入，
 * 见 `routes/skills.ts` 的文件头）。装配面仍以「函数」形态给出——贡献的 `value` 必须是惰性构造函数，
 * 这里只是把既有实例包一层，不复制第二份。
 */
export function createSkillDownloadAppRoutes() {
  return skillDownloadRoutes;
}
