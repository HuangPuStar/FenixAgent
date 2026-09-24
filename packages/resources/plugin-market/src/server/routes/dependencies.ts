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

/** 会话认证守卫；`/web/config/plugin-market/*` 靠它取得 `store.actor`。 */
export interface PluginMarketRouteDependencies {
  readonly authGuardPlugin: AnyElysia;
}
