/**
 * Workflow V2 路由的宿主注入依赖。
 *
 * 单独成文件而不是放在 `src/server.ts`：路由工厂需要声明自己的依赖类型，若类型定义在包入口，
 * 就会出现「入口 → 工厂 → 入口」的循环导入。这里只放类型，运行时不产生任何依赖。
 *
 * 为什么是注入而不是本包自建守卫：Elysia 的 `macro` / `state` 是实例作用域的，父实例无法向已构造的
 * 子实例回填。守卫必须与宿主的认证解析（session cookie → Environment Secret → API Key 的优先级、
 * active organization 提取、测试 seam）是同一份实例，否则同一进程会出现两套互不可见的认证状态。
 *
 * 只覆盖 `web` 槽（`/web/workflow-v2/*`）：两条 `app` 槽贡献不走会话守卫——`/workflow-canvas/bff/*` 的
 * 凭据是请求头票据，`/workflow-canvas/*` 是同源 iframe 的静态资产（冻结 §2.1）。
 */

import type { AnyElysia } from "elysia";

/**
 * 会话认证守卫写入 `store.authContext` 的字段中，本包控制台路由实际消费的部分。
 *
 * 只声明用到的两个字段（而非宿主的完整 `AuthContext`）：本包的租户边界就是「会话守卫已认证的 active
 * organization」，角色与成员关系由 Facade 在需要时按组织谓词处理，路由层不解释身份语义。宿主传入更宽的
 * 对象天然满足本类型。
 */
export interface WorkflowV2ActorContext {
  readonly organizationId: string;
  readonly userId: string;
}

/** `/web/workflow-v2/*` 控制台路由的宿主注入依赖。 */
export interface WorkflowV2RouteDependencies {
  /** 会话认证守卫；路由靠它取得 `store.authContext`。 */
  readonly authGuardPlugin: AnyElysia;
}
