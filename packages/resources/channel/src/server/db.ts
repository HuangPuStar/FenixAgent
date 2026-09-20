import { getDatabase } from "@fenix/platform-sdk/server";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

/**
 * Channel 仓储使用的 DB 句柄类型。
 *
 * 表定义当前仍由宿主 `@server/db/schema` 提供（表定义迁出归任务 1.7，见任务 1.3 实施记录 §四），
 * 但句柄类型刻意不写成 `typeof schema` 聚合类型：本包仓储只做 `select` / `insert` / `update` /
 * `delete`，不使用 `db.query.*` 关系查询，表定义迁出后这里无需改动。
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
