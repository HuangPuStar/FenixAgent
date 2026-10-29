import type { AnyElysia } from "elysia";

/**
 * Channel 路由的宿主注入依赖（`/web/channels/langbot` 与 `/api/system/channels`）。
 *
 * 单独成文件而不是写在包入口：路由工厂需要声明自己的依赖类型，若类型定义在 `src/server.ts`，就会出现
 * 「入口 → 工厂 → 入口」的循环导入。
 *
 * 为什么守卫必须注入：Elysia 的 `macro` / `state` 是实例作用域的，父实例无法向已构造的子实例回填。
 * 守卫必须与宿主的认证解析是同一份实例，否则 `/web/*` 的 `store.actor` 在本插件里不可见。
 */

export interface ChannelWebRouteDependencies {
  /** 会话认证守卫；提供 `sessionAuth` 宏与 `store.actor`。 */
  readonly authGuardPlugin: AnyElysia;
}

/**
 * `/api/system/channels` 的宿主注入依赖。
 *
 * 与 {@link ChannelWebRouteDependencies} 分开：这条路由的凭据是系统 master key（`RCS_SYSTEM_API_KEYS`），
 * 不是登录会话，两者不能共用同一个守卫实例，否则系统面会凭空拿到一份它不该有的会话状态。
 */
export interface ChannelSystemApiRouteDependencies {
  /** 系统 API key 守卫（`RCS_SYSTEM_API_KEYS`），提供 `systemApiKeyAuth` 宏。 */
  readonly systemApiGuardPlugin: AnyElysia;
}
