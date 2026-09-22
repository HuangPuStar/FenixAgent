import { getDatabase } from "@fenix/platform-sdk/server";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

/**
 * Task 仓储使用的 DB 句柄类型。
 *
 * 表定义自任务 1.7 B12 起由本包 `db/schema.ts` 持有（出口 `@fenix/resource-task/db`），句柄类型仍刻意不写
 * `typeof schema`：仓储只做 `select` / `insert` / `update` / `delete`，不使用 `db.query.*` 关系查询，因此
 * 不需要耦合 schema 聚合类型——表定义从宿主迁入本包时这里确实一行未改。
 */
export type TaskDatabase = NodePgDatabase<Record<string, never>>;

/**
 * 取得 Task 模块的 DB 句柄。
 *
 * 只能在处理请求、任务或启动逻辑时调用，不能在模块加载期调用——模块加载可能早于宿主的
 * `initializeApplicationInfrastructure()`，而那之前 `getDatabase()` 会抛错。这正是仓储不能再持有
 * 模块级 `db` 常量的原因（旧写法 `import { db } from "@server/db"`）。
 */
export function getTaskDatabase(): TaskDatabase {
  return getDatabase<TaskDatabase>();
}
