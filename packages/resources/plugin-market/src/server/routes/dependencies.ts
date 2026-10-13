import type { AnyElysia } from "elysia";

/**
 * 插件市场路由的宿主注入依赖。
 *
 * 单独成文件而不是放在包入口：路由工厂需要声明自己的依赖类型，若类型定义在入口，就会出现「入口 → 工厂 →
 * 入口」的循环导入。这里只放类型，运行时不产生任何依赖。
 *
 * 为什么是注入而不是本包自建守卫：Elysia 的 `macro` / `state` 是实例作用域的，父实例无法向已构造的子实例
 * 回填。守卫必须与宿主的认证解析（session cookie / Environment Secret / API Key、测试 seam、active
 * organization 解析）是同一份实例，否则同一进程会出现两套互不可见的认证状态，且 Elysia 会按 plugin
 * `name` 去重让先构造的一方静默生效。包内用例注入替身（`src/__tests__/guard-stubs.ts`）。
 */

/** 插件市场两条面的宿主登录守卫；两个不同的凭据族，见下方字段说明。 */
export interface PluginMarketRouteDependencies {
  /** 会话认证守卫；`/web/config/plugin-market/*`（浏览面）靠它取得 `store.actor`。 */
  readonly authGuardPlugin: AnyElysia;
  /**
   * 系统 API Key 守卫；`/api/system/plugin-market/*`（管理面）靠它的 `systemApiKeyAuth` 宏放行。
   *
   * 与上面那道门是**两个互不相关的凭据族**：系统 key 落在 `RCS_SYSTEM_API_KEYS`，宿主刻意不为它恢复用户 /
   * 组织上下文（因此管理面的 handler 没有 actor 可传）。把两道门合成一道会让「谁可以管理市场」这件事
   * 悄悄漂回会话角色判定，而管理面的判据是凭据本身。
   */
  readonly systemApiGuardPlugin: AnyElysia;
}
