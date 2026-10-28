import type { AnyElysia } from "elysia";

/**
 * `/web/channels/langbot` 的宿主注入依赖。
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
