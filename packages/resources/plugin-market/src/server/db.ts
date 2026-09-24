import { getDatabase } from "@fenix/platform-sdk/server";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

/**
 * 插件市场仓储使用的 DB 句柄类型。
 *
 * 不写 `typeof schema`：本包只做 `select` / `insert` / `update` / `delete` / `transaction`，不使用
 * `db.query.*` 关系查询，因此不需要耦合 schema 聚合类型。
 */
export type PluginMarketDatabase = NodePgDatabase<Record<string, never>>;

/**
 * 事务句柄类型：`transaction(fn)` 回调参数的形状。
 *
 * 需要它是因为事务边界在 service（`withPackageLock` 开启事务），而语句在 repository：后者必须能声明
 * 「我要一个事务句柄，不要一个普通句柄」——把参数写成 `PluginMarketDatabase` 会让「这条语句必须在事务里」
 * 的约束悄悄失效（普通句柄同样能编译通过）。
 */
export type PluginMarketTransaction = Parameters<Parameters<PluginMarketDatabase["transaction"]>[0]>[0];

/** 只读行来源：普通句柄与事务句柄都满足它，供「读当前状态」这类无事务要求的查询使用。 */
export type PluginMarketReader = Pick<PluginMarketDatabase, "select">;

/**
 * 取得插件市场模块的 DB 句柄。
 *
 * 只能在处理请求、任务或启动逻辑时调用，**不能在模块加载期调用**，否则可能早于宿主的
 * `initializeApplicationInfrastructure()`。
 */
export function getPluginMarketDatabase(): PluginMarketDatabase {
  return getDatabase<PluginMarketDatabase>();
}
