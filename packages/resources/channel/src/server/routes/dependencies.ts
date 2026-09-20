/**
 * Channel 路由的宿主注入依赖。
 *
 * 单独成文件而不是放在 `src/server.ts`：路由工厂需要声明自己的依赖类型，若类型定义在包入口，
 * 就会出现「入口 → 工厂 → 入口」的循环导入。这里只放类型，运行时不产生任何依赖。
 *
 * 为什么守卫是注入而不是本包自建：Elysia 的 `macro` / `state` 是实例作用域的，父实例无法向已
 * 构造的子实例回填。守卫必须与宿主的认证解析（含测试 seam、ALS 增强、active organization 解析）
 * 是同一份实例，否则同一进程会出现两套互不可见的认证状态。
 *
 * 为什么 Environment 归属查询也是注入：它读的是 Environment 表，而 Environment 的 owner 是
 * `@fenix/agent-runtime`（固定槽位，§2.3 矩阵）。本包只消费其中三个字段（id / name / organizationId），
 * 因此按**用到的形状**声明，而不是把 agent-runtime 的完整仓储记录类型引入协议边界——记录字段改名
 * 不会波及这里。注入还让包内用例不必依赖宿主 preload 的模块替身（`@server/test-utils/stubs/*`），
 * 这正是本任务要切断的耦合。
 */

import type { AnyElysia } from "elysia";

/**
 * 通道路由需要的 Environment 归属查询子集。
 *
 * `getById` 允许返回 `null`/`undefined`：绑定可能指向已被删除的 Environment，此时路由按「环境
 * 不可读」处理（列表补空名称、写操作拒绝），而不是把它当成查询失败。
 */
export interface ChannelEnvironmentLookup {
  /** 按 Environment ID 查其所属组织与展示名。 */
  getById(id: string): Promise<{ id: string; name: string; organizationId: string | null } | null | undefined>;
  /** 列出某组织下的 Environment（用于把绑定过滤到当前组织）。 */
  listByOrganizationId(organizationId: string): Promise<ReadonlyArray<{ id: string; name: string }>>;
}

/** `/web/channels/*` 控制台路由的宿主注入依赖。 */
export interface WebChannelRouteDependencies {
  /** 会话认证守卫；路由靠它取得 `store.authContext`。 */
  readonly authGuardPlugin: AnyElysia;
  /** Environment 归属查询；实现由宿主用 `@fenix/agent-runtime/server` 的 `environmentRepo` 提供。 */
  readonly environmentLookup: ChannelEnvironmentLookup;
}
