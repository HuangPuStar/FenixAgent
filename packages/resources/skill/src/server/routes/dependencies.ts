/**
 * Skill 路由的宿主注入依赖。
 *
 * 单独成文件而不是放在 `src/server.ts`：路由工厂需要声明自己的依赖类型，若类型定义在包入口，
 * 就会出现「入口 → 工厂 → 入口」的循环导入。这里只放类型，运行时不产生任何依赖。
 *
 * 为什么是注入而不是本包自建守卫：Elysia 的 `macro` / `state` 是实例作用域的，父实例无法向已构造的
 * 子实例回填。守卫必须与宿主的认证解析（含测试 seam、ALS 增强、active organization 解析）是同一份
 * 实例，否则同一进程会出现两套互不可见的认证状态。
 */

import type { AnyElysia } from "elysia";

/**
 * `/api/skills`（对外已发布合同）与 `/web/config/skills`（控制台）共用的注入依赖。
 *
 * 两处都用宿主的同一个 `authGuardPlugin` 的 `sessionAuth` 宏：cookie → Environment Secret →
 * API Key 的解析顺序、以及「已认证但缺组织上下文」这类边界都在宿主实现里，资源包再声明一个形状
 * 相同的接口只会得到一份需要同步维护的副本。等对外 API 改用独立的 key 守卫（如沙盒的系统 key 守卫）
 * 时再按沙盒的写法分列两个接口。
 */
export interface SkillRouteDependencies {
  /** 会话认证守卫；两条路由都靠它写入 `store.actor`。 */
  readonly authGuardPlugin: AnyElysia;
}
