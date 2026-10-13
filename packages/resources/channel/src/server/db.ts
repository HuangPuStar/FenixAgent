import { getDatabase } from "@fenix/platform-sdk/server";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

/**
 * Channel 仓储使用的 DB 句柄类型。
 *
 * 表定义自任务 1.7 B13 起由本包 `db/schema.ts` 持有（出口 `@fenix/resource-channel/db`），句柄类型仍刻意
 * 不写成 `typeof schema` 聚合类型：本包仓储只做 `select` / `insert` / `update` / `delete`，不使用
 * `db.query.*` 关系查询——表定义从宿主迁入本包时这里确实一行未改（与 task / prod-view 同形）。
 */
export type ChannelDatabase = NodePgDatabase<Record<string, never>>;

/**
 * 取得 Channel 模块的 DB 句柄。
 *
 * 只能在处理请求或启动逻辑时调用，不能在模块加载期调用：宿主
 * `initializeApplicationInfrastructure()` 之前 `getDatabase()` 会 fail-fast，而平台 registry 会
 * 在基础设施就绪前导入模块图（与 `@fenix/resource-sandbox` 的 `db.ts` 同口径）。
 */
export function getChannelDatabase(): ChannelDatabase {
  return getDatabase<ChannelDatabase>();
}
