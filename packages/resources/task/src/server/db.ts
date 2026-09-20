import { getDatabase } from "@fenix/platform-sdk/server";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

/**
 * Task 仓储使用的 DB 句柄类型。
 *
 * 表定义当前仍由宿主 `@server/db/schema` 提供（迁出归任务 1.7），但句柄类型刻意不写 `typeof schema`：
 * 仓储只做 `select` / `insert` / `update` / `delete`，不使用 `db.query.*` 关系查询，因此不需要耦合
 * 宿主的 schema 聚合类型；表定义迁出后这里无需改动。
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
