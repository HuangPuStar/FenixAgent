import { getDatabase } from "@fenix/platform-sdk/server";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

/**
 * Skill 仓储使用的 DB 句柄类型。
 *
 * 表定义自任务 1.7 B5 起由本包 `db/schema.ts` 提供（`@fenix/resource-skill/db`），但句柄类型刻意不写
 * `typeof schema`：仓储只做 `select` / `insert` / `update` / `delete`，不使用 `db.query.*`
 * 关系查询，因此不需要耦合 schema 聚合类型——迁表前它解开了对宿主 schema 类型的耦合，迁表后同样不必
 * 改成 `typeof skillSchema`。
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
