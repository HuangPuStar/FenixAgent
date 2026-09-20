/**
 * Observer 路由的宿主注入依赖。
 *
 * 单独成文件而不是放在 `src/server.ts`：路由工厂需要声明自己的依赖类型，若类型定义在包入口，
 * 就会出现「入口 → 工厂 → 入口」的循环导入。这里只放类型，运行时不产生任何依赖。
 *
 * 为什么是注入而不是本包自建守卫：Elysia 的 `macro` / `state` 是实例作用域的，父实例无法向已
 * 构造的子实例回填。三个系统级路由都声明 `systemApiKeyAuth: true`，该 macro 必须由宿主
 * `systemApiAuthPlugin` 提供——它读 `RCS_SYSTEM_API_KEYS` 并写 `store.systemAuth`，必须与宿主的
 * 系统 key 解析是同一份实例，否则同一进程会出现两套互不可见的系统认证状态。
 */

import type { AnyElysia } from "elysia";

/** `/api/system/*` 系统管理路由的宿主注入依赖。 */
export interface SystemApiObserverRouteDependencies {
  /** 系统 API key 守卫（`RCS_SYSTEM_API_KEYS`），与普通请求认证互不相关。 */
  readonly systemApiGuardPlugin: AnyElysia;
}
