import { getDatabase } from "@fenix/platform-sdk/server";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

/**
 * Agent Runtime 仓储与领域服务使用的 DB 句柄类型。
 *
 * 表定义当前仍由宿主 `@server/db/schema` 提供（迁出归任务 1.7），但句柄类型刻意不写 `typeof schema`：
 * 本包只做 `select` / `insert` / `update` / `delete`，不使用 `db.query.*` 关系查询，因此不需要耦合宿主的
 * schema 聚合类型；表定义迁出后这里无需改动（与 machine / knowledge / agent-config 同口径）。
 */
export type AgentRuntimeDatabase = NodePgDatabase<Record<string, never>>;

/**
 * 取得 Agent Runtime 的 DB 句柄。
 *
 * 只能在处理请求、任务或启动逻辑时调用，不能在模块加载期调用：句柄由宿主的
 * `initializeApplicationInfrastructure()` 装入应用基础设施，模块加载期读取会早于该初始化并失败。
 */
export function getAgentRuntimeDatabase(): AgentRuntimeDatabase {
  return getDatabase<AgentRuntimeDatabase>();
}
