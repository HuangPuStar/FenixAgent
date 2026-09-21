import { getDatabase } from "@fenix/platform-sdk/server";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

/**
 * MCP 仓储使用的 DB 句柄类型。
 *
 * 表定义已随 §1.7 B2 迁到本包 `db/schema.ts`，但句柄类型刻意仍不写 `typeof schema`：本包只做
 * `select` / `insert` / `update` / `delete` / `transaction`，不使用 `db.query.*` 关系查询，因此不需要
 * 耦合 schema 聚合类型——这也是迁移前后这里的类型无需改动的原因。
 */
export type McpDatabase = NodePgDatabase<Record<string, never>>;

/**
 * 取得 MCP 模块的 DB 句柄。
 *
 * 只能在处理请求、任务或启动逻辑时调用，不能在模块加载期调用，否则可能早于宿主的
 * `initializeApplicationInfrastructure()`。
 */
export function getMcpDatabase(): McpDatabase {
  return getDatabase<McpDatabase>();
}
