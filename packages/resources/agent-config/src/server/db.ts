import { getDatabase } from "@fenix/platform-sdk/server";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

/**
 * AgentConfig 仓储使用的 DB 句柄类型。
 *
 * 表定义当前仍由宿主 `@server/db/schema` 提供（迁出归任务 1.7，1.3 的显式残留），但句柄类型刻意不写
 * `typeof schema`：仓储只做 `select` / `insert` / `update` / `delete` / `transaction`，不使用
 * `db.query.*` 关系查询，因此不需要耦合宿主的 schema 聚合类型；表定义迁出后这里无需改动。
 */
export type AgentConfigDatabase = NodePgDatabase<Record<string, never>>;

/**
 * 取得本模块的 DB 句柄。
 *
 * 只能在处理请求、任务或启动逻辑时调用，不能在模块加载期调用：宿主的
 * `initializeApplicationInfrastructure()` 在装配阶段才执行，模块加载期读取会抛错（迁移前模块级
 * `import { db } from "@server/db"` 正好是这种形状，切断宿主内部依赖时一并纠正）。因此每次调用
 * 都重新取句柄，不缓存到模块作用域。
 */
export function getAgentConfigDatabase(): AgentConfigDatabase {
  return getDatabase<AgentConfigDatabase>();
}
