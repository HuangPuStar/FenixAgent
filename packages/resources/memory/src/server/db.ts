import { getDatabase } from "@fenix/platform-sdk/server";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

/**
 * Memory 仓储使用的 DB 句柄类型。
 *
 * 本包唯一的表定义自任务 1.7 B10 起由本包持有（`db/schema.ts`，出口 `@fenix/resource-memory/db`），但
 * 句柄类型仍刻意不写 `typeof schema`：仓储只做 `select` / `insert` / `update`，不使用 `db.query.*`
 * 关系查询，因此不需要耦合任何 schema 聚合类型。表定义迁出后这里**无需改动**——这正是当初不写
 * `typeof schema` 的目的（同口径见 `@fenix/agent-config` 的 `src/server/db.ts`）。
 */
export type MemoryDatabase = NodePgDatabase<Record<string, never>>;

/**
 * 取得 Memory 模块的 DB 句柄。
 *
 * 只能在处理请求、任务或启动逻辑时调用，不能在模块加载期调用，否则可能早于宿主的
 * `initializeApplicationInfrastructure()`。
 */
export function getMemoryDatabase(): MemoryDatabase {
  return getDatabase<MemoryDatabase>();
}
