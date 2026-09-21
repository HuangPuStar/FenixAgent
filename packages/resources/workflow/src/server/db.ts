import { getDatabase } from "@fenix/platform-sdk/server";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

/**
 * Workflow 仓储使用的 DB 句柄类型。
 *
 * 表定义自任务 1.7 B6 起由本包 `db/schema.ts` 提供，但句柄类型刻意不写
 * `typeof schema`：仓储只做 `select` / `insert` / `update` / `delete` / `transaction`，
 * 不使用 `db.query.*` 关系查询，因此不需要耦合 schema 聚合类型；迁表前它解开的是对宿主 schema 类型的
 * 耦合，迁表后同样不必改成 `typeof workflowSchema`。
 */
export type WorkflowDatabase = NodePgDatabase<Record<string, never>>;

/**
 * 取得 Workflow 模块的 DB 句柄。
 *
 * 只能在处理请求、任务或启动逻辑时调用，不能在模块加载期调用，否则可能早于宿主的
 * `initializeApplicationInfrastructure()`。句柄必须每次现取：宿主在模块加载后才完成初始化。
 */
export function getWorkflowDatabase(): WorkflowDatabase {
  return getDatabase<WorkflowDatabase>();
}
