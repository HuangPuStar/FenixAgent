import { getDatabase } from "@fenix/platform-sdk/server";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

/**
 * 工单仓储使用的 DB 句柄类型。
 *
 * 口径与 `@fenix/resource-task` / `@fenix/git` 一致：刻意不写 `typeof schema`——仓储只用
 * `select` / `insert` / `update`，不使用 `db.query.*` 关系查询，因此不需要耦合 schema 聚合类型
 * （五张表定义在本包 `db/schema.ts`，经 `@fenix/resource-tickets/db` 出口被仓储直接引用）。
 */
export type TicketDatabase = NodePgDatabase<Record<string, never>>;

/**
 * 取得工单模块的 DB 句柄。
 *
 * 只能在请求、任务或启动逻辑中调用，不能在模块加载期调用：模块加载可能早于宿主的
 * `initializeApplicationInfrastructure()`，那之前 `getDatabase()` 会抛错。仓储因此不持有模块级
 * db 常量——句柄在事务上下文中还会被平台切换成事务连接（`runInTransaction` 的 AsyncLocalStorage），
 * 缓存下来会绕过事务边界，让「先清旧默认再置新默认」这类读改写落到事务之外。
 */
export function getTicketsDatabase(): TicketDatabase {
  return getDatabase<TicketDatabase>();
}
