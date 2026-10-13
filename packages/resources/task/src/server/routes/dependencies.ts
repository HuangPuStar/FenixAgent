/**
 * Task 路由的宿主注入依赖。
 *
 * 单独成文件而不是放在 `src/server.ts`：路由工厂需要声明自己的依赖类型，若类型定义在包入口，就会出现
 * 「入口 → 工厂 → 入口」的循环导入。这里只放类型，运行时不产生任何依赖。
 *
 * 为什么是注入而不是本包自建守卫：Elysia 的 `macro` / `state` 是实例作用域的，父实例无法向已构造的
 * 子实例回填。守卫必须与宿主的认证解析（session cookie / Environment Secret / API Key 的依次尝试、
 * active organization 解析、测试 seam）是同一份实例，否则同一进程会出现两套互不可见的认证状态——
 * 且插件 `name` 去重会让后构造的一方静默失效。
 */

import type { AnyElysia } from "elysia";

/** `/web/tasks/v2` 控制台路由的宿主注入依赖。 */
export interface WebTaskRouteDependencies {
  /** 会话认证守卫；`/web/*` 靠它取得 `authContext`（`store.authContext`）。 */
  readonly authGuardPlugin: AnyElysia;
}
