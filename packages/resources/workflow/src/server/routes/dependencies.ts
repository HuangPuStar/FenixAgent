/**
 * Workflow 路由的宿主注入依赖。
 *
 * 单独成文件而不是放在 `src/server.ts`：路由工厂需要声明自己的依赖类型，若类型定义在包入口，
 * 就会出现「入口 → 工厂 → 入口」的循环导入。这里只放类型，运行时不产生任何依赖。
 *
 * 为什么是注入而不是本包自建守卫：Elysia 的 `macro` / `state` 是实例作用域的，父实例无法向已
 * 构造的子实例回填。守卫必须与宿主的认证解析（含测试 seam、ALS 增强、active organization 解析）
 * 是同一份实例，否则同一进程会出现两套互不可见的认证状态。
 */

import type { AnyElysia } from "elysia";

/**
 * 会话认证守卫写入 `store.authContext` 的字段中，本包实际消费的部分。
 *
 * 只声明用到的两个字段（而非宿主的完整 `AuthContext`）：资源包不解释 `role` 等身份语义，
 * 也不应因为宿主给 authContext 加字段而被迫跟进。宿主传入更宽的对象天然满足本类型。
 */
export interface WorkflowActorContext {
  readonly organizationId: string;
  readonly userId: string;
}

/** `/web/*` 控制台路由与 `/api/workflows/*` 的宿主注入依赖（两者都由会话守卫保护）。 */
export interface WorkflowRouteDependencies {
  /** 会话认证守卫；路由靠它取得 `store.authContext`。 */
  readonly authGuardPlugin: AnyElysia;
}
