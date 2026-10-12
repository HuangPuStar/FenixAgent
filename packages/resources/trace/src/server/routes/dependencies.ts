import type { AnyElysia } from "elysia";

/**
 * 本包 `/web/*` 路由的宿主注入依赖。
 *
 * 类型单独成文件而不是放 `src/server.ts`：路由模块需要声明自己的依赖，若类型定义在包入口就会出现
 * 「入口 → 路由 → 入口」的循环导入。
 *
 * 为什么守卫与归属校验都必须注入而不能包内自建：Elysia 的 `macro` / `state` 是实例作用域的，包内自建一份
 * 会让同一进程出现两套互不可见的认证状态（表现成「所有请求 401」而不是装配错误）；`Environment` 表的 owner
 * 是 `@fenix/agent-runtime`，依赖矩阵不允许资源包依赖该包，宿主是唯一同时持有两侧的装配层。
 */

/**
 * Environment 归属校验的形状。
 *
 * 不引用 `@fenix/agent-runtime` 的类型（依赖矩阵不允许 `packages/resources/*` 依赖该包），按消费侧真正用到的
 * 语义声明——「校验通过则返回，不存在、跨组织或跨用户都抛 `NotFoundError`」；返回值本包不消费。
 */
export type EnvironmentOwnershipCheck = (
  environmentId: string,
  organizationId: string,
  userId: string,
) => Promise<unknown>;

/** 本包 `/web/*` 路由的宿主注入依赖。 */
export interface WebTraceRouteDependencies {
  /** 会话认证守卫；`/web/*` 靠它取得 `store.user` / `store.authContext` 与 `sessionAuth` 宏。 */
  readonly authGuardPlugin: AnyElysia;
  /** 校验 environment 归属；不存在、跨组织或跨用户一律抛 `NotFoundError`。 */
  readonly getOwnedEnvironment: EnvironmentOwnershipCheck;
}
