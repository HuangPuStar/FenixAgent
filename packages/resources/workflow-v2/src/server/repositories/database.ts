import { getDatabase } from "@fenix/platform-sdk/server";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

/**
 * Workflow V2 仓储使用的 DB 句柄类型。
 *
 * 与既有资源包同形（`@fenix/resource-skill` 的 `db.ts`）：表定义由本包 `db/schema.ts` 提供，但句柄类型
 * 刻意不写 `typeof schema`——仓储只做 `select` / `insert` / `update`，不使用 `db.query.*` 关系查询，
 * 因此不需要耦合 schema 聚合类型。
 */
export type WorkflowV2Database = NodePgDatabase<Record<string, never>>;

/**
 * 取得 Workflow V2 的 DB 句柄。
 *
 * 只能在处理请求时调用，不能在模块加载期调用，否则可能早于宿主的
 * `initializeApplicationInfrastructure()`。用例经
 * `initializeTestApplicationInfrastructure({ database })` 注入同形句柄（真实 Postgres 或替身）。
 */
export function getWorkflowV2Database(): WorkflowV2Database {
  return getDatabase<WorkflowV2Database>();
}
