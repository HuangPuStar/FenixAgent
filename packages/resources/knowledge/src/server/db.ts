import { getDatabase } from "@fenix/platform-sdk/server";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

/**
 * Knowledge 仓储使用的 DB 句柄类型。
 *
 * 三张领域表的定义自任务 1.7 B9 起由本包持有（`db/schema.ts`，出口 `@fenix/resource-knowledge/db`），
 * 但句柄类型仍刻意不写 `typeof schema`：仓储只做 `select` / `insert` / `update` / `delete`，不使用
 * `db.query.*` 关系查询，因此不需要耦合任何 schema 聚合类型（与 agent-runtime / agent-config 同口径）。
 */
export type KnowledgeDatabase = NodePgDatabase<Record<string, never>>;

/**
 * 取得 Knowledge 模块的 DB 句柄。
 *
 * 只能在处理请求、任务或启动逻辑时调用，不能在模块加载期调用，否则可能早于宿主的
 * `initializeApplicationInfrastructure()`。
 */
export function getKnowledgeDatabase(): KnowledgeDatabase {
  return getDatabase<KnowledgeDatabase>();
}
