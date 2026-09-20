/**
 * Memory 路由的宿主注入依赖。
 *
 * 单独成文件而不是放在 `src/server.ts`：路由工厂需要声明自己的依赖类型，若类型定义在包入口，
 * 就会出现「入口 → 工厂 → 入口」的循环导入。这里只放类型，运行时不产生任何依赖。
 *
 * 为什么是注入而不是本包自建守卫：Elysia 的 `macro` / `state` 是实例作用域的，父实例无法向已
 * 构造的子实例回填。守卫必须与宿主的认证解析（含测试 seam、ALS 增强、active organization 解析）
 * 是同一份实例，否则同一进程会出现两套互不可见的认证状态——`/web/hindsight/**` 会读到宿主守卫
 * 从未写入的 `store.authContext`。
 */

import type { AnyElysia } from "elysia";

/** `/web/hindsight/**` 控制台路由的宿主注入依赖。 */
export interface WebHindsightRouteDependencies {
  /** 会话认证守卫；`/web/*` 靠它取得 `store.authContext`。 */
  readonly authGuardPlugin: AnyElysia;
}
