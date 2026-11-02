import { getDatabase } from "@fenix/platform-sdk/server";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

/**
 * Channel 仓储使用的 DB 句柄类型。
 *
 * 刻意不写 `typeof schema`：仓储只用 `select` / `insert` / `update`，不使用 `db.query.*` 关系查询，
 * 因此不需要耦合 schema 聚合类型（表定义经 `@fenix/resource-channel/db` 出口被仓储直接引用）。
 */
export type ChannelDatabase = NodePgDatabase<Record<string, never>>;

/**
 * 取得 Channel 模块的 DB 句柄。
 *
 * 只能在处理请求、任务或启动逻辑时调用：模块加载可能早于宿主的
 * `initializeApplicationInfrastructure()`。仓储也不在模块级缓存句柄——平台在事务上下文中会把它切换成
 * 事务连接（`runInTransaction` 的 AsyncLocalStorage），缓存会绕过事务边界。
 */
export function getChannelDatabase(): ChannelDatabase {
  return getDatabase<ChannelDatabase>();
}
