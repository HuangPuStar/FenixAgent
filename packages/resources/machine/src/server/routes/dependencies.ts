/**
 * Machine 路由的宿主注入依赖。
 *
 * 单独成文件而不是放在 `src/server.ts`：路由工厂需要声明自己的依赖类型，若类型定义在包入口，就会出现
 * 「入口 → 工厂 → 入口」的循环导入。这里只放类型，运行时不产生任何依赖。
 *
 * 为什么是注入而不是本包自建守卫：Elysia 的 `macro` / `state` 是实例作用域的，父实例无法向已构造的子实例
 * 回填。守卫必须与宿主的认证解析（含测试 seam、active organization 解析、Environment Secret / API Key
 * 三条路径）是同一份实例，否则同一进程会出现两套互不可见的认证状态：路由读得到 `store.authContext`，
 * 而 Host 侧的 session 记录、限流与审计看不到这次请求。
 */

import type { AnyElysia } from "elysia";

/** `/web/*` 控制台路由的宿主注入依赖。 */
export interface WebMachineRouteDependencies {
  /** 会话认证守卫；`/web/*` 靠它取得 `store.authContext` 与 `store.user`。 */
  readonly authGuardPlugin: AnyElysia;
}

/**
 * 认证结果的窄视图：只声明 WS 端点读取的字段。
 *
 * WS 升级不经过 `sessionAuth` 宏（Elysia 的 sessionAuth 只覆盖 HTTP 请求），因此文件变更事件端点必须自行
 * 调用宿主的显式认证入口。宿主的 `RequestAuthResult` 结构上满足本视图，无需转换。
 */
export interface MachineRequestAuthResult {
  /** 已认证用户；用户信息缺失按未认证处理。 */
  readonly user?: { readonly id: string } | null;
  /** 请求级认证上下文；无组织上下文按未认证处理（文件事件按环境隔离，必须有组织）。 */
  readonly authContext?: { readonly organizationId: string } | null;
}

/** `/web/file-events` WS 路由的宿主注入依赖。 */
export interface WebFileEventsRouteDependencies {
  /**
   * 显式请求认证入口（宿主 `authenticateRequest`）。
   *
   * 与 `authGuardPlugin` 同源：必须来自宿主同一份实现，否则 WS 端点会用另一套解析规则判定身份。
   * 认证阶段抛出的 `RATE_LIMITED` 由路由映射为 close(4008)，其余异常向上抛。
   */
  readonly authenticateRequest: (request: Request) => Promise<MachineRequestAuthResult | null>;
}
