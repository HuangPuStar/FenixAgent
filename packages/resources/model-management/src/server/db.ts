import { getDatabase } from "@fenix/platform-sdk/server";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

/**
 * 本包仓储使用的 DB 句柄类型。
 *
 * 表定义仍由宿主 `@server/db/schema` 提供（`provider` / `model` / `model_gateway_credential` 的迁移
 * 归任务 1.7），句柄类型刻意不写 `typeof schema`：本包仓储只做 `select` / `insert` / `update` /
 * `delete`，不使用 `db.query.*` 关系查询，因此不需要耦合宿主的 schema 聚合类型；表定义迁出后这里
 * 无需改动。
 */
export type ModelManagementDatabase = NodePgDatabase<Record<string, never>>;

/**
 * 取得本模块的 DB 句柄。
 *
 * 迁移前这里是 `import { db } from "@server/db"`——模块加载期就绑定宿主单例，包离开宿主装配顺序后既
 * 无法独立取值，也让「宿主尚未完成基础设施初始化」这一状态无处表达。改经平台契约 `getDatabase()`
 * 后，读取发生在调用期（请求 / 任务 / 启动逻辑），与 `@fenix/platform-sdk/server` 的约定一致。
 *
 * 因此本函数不得在模块顶层调用：宿主 `main.ts` 的 `initializeApplicationInfrastructure()` 之前
 * 读取会抛错。
 */
export function getModelManagementDatabase(): ModelManagementDatabase {
  return getDatabase<ModelManagementDatabase>();
}
