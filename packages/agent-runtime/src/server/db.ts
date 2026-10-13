import { getDatabase } from "@fenix/platform-sdk/server";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

/**
 * Agent Runtime 仓储与领域服务使用的 DB 句柄类型。
 *
 * 本包两张表（`environment` / `agent_instance`）的定义自任务 1.7 B8 起由本包持有（`db/schema.ts`，出口
 * `@fenix/agent-runtime/db`），但句柄类型仍刻意不写 `typeof schema`：本包只做 `select` / `insert` /
 * `update` / `delete`，不使用 `db.query.*` 关系查询，因此不需要耦合任何 schema 聚合类型（宿主迁出前那一版
 * 同样如此，迁出后无需改动——这正是当初不写 `typeof schema` 的目的；与 machine / knowledge / agent-config
 * 同口径）。
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
