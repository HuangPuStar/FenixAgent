import { getDatabase } from "@fenix/platform-sdk/server";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

/**
 * Machine 仓储与领域服务使用的 DB 句柄类型。
 *
 * 本包自己的表定义已迁至 `@fenix/resource-machine/db`（§1.7），句柄类型刻意不写 `typeof schema`：
 * 本包只做 `select` / `insert` / `update` / `delete`，不使用 `db.query.*` 关系查询，因此不需要耦合宿主的
 * schema 聚合类型；残余的跨模块表读取也共用这个句柄类型。
 */
export type MachineDatabase = NodePgDatabase<Record<string, never>>;

/**
 * 取得 Machine 模块的 DB 句柄。
 *
 * 只能在处理请求、任务或启动逻辑时调用，不能在模块加载期调用，否则可能早于宿主的
 * `initializeApplicationInfrastructure()`。
 */
export function getMachineDatabase(): MachineDatabase {
  return getDatabase<MachineDatabase>();
}
