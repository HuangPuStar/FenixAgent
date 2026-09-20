import { getDatabase } from "@fenix/platform-sdk/server";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

/**
 * ProdView 仓储使用的 DB 句柄类型。
 *
 * 表定义当前仍由宿主 `@server/db/schema` 提供（迁出归任务 1.7），但句柄类型刻意不写
 * `typeof schema`：仓储只做 `select` / `insert` / `update` / `delete`，不使用 `db.query.*`
 * 关系查询，因此不需要耦合宿主的 schema 聚合类型；表定义迁出后这里无需改动。
 */
export type ProdViewDatabase = NodePgDatabase<Record<string, never>>;

/**
 * 取得 ProdView 模块的 DB 句柄。
 *
 * 只能在处理请求时调用，不能在模块加载期调用：模块图可能早于宿主的
 * `initializeApplicationInfrastructure()` 求值，届时 `getDatabase()` 会抛错。本函数不从
 * `src/server.ts` 转出——句柄是宿主装配的产物，包外拿不到额外语义，转出只会多一条装配入口。
 */
export function getProdViewDatabase(): ProdViewDatabase {
  return getDatabase<ProdViewDatabase>();
}
