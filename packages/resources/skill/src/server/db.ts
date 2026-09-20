import { getDatabase } from "@fenix/platform-sdk/server";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

/**
 * Skill 仓储使用的 DB 句柄类型。
 *
 * 表定义当前仍由宿主 `@server/db/schema` 提供（迁出归任务 1.7），但句柄类型刻意不写
 * `typeof schema`：仓储只做 `select` / `insert` / `update` / `delete`，不使用 `db.query.*`
 * 关系查询，因此不需要耦合宿主的 schema 聚合类型；表定义迁出后这里无需改动。
 */
export type SkillDatabase = NodePgDatabase<Record<string, never>>;

/**
 * 取得 Skill 模块的 DB 句柄。
 *
 * 只能在处理请求、任务或启动逻辑时调用，不能在模块加载期调用，否则可能早于宿主的
 * `initializeApplicationInfrastructure()`。
 */
export function getSkillDatabase(): SkillDatabase {
  return getDatabase<SkillDatabase>();
}
