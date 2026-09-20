import { getDatabase } from "@fenix/platform-sdk/server";
import type { drizzleAdapter } from "better-auth/adapters/drizzle";

/**
 * 身份模块使用的 DB 句柄类型。
 *
 * 它直接取自 better-auth drizzle adapter 的入参约束，而不是自行发明一个结构类型：adapter 是
 * 本模块对 DB 的最严格消费者，用它的签名可以保证句柄类型既够用又不会漂移。仓储层只做
 * `select/insert/update/delete`，不使用 `db.query.*`，因此无需耦合宿主的 schema 聚合类型。
 */
export type IdentityDatabase = Parameters<typeof drizzleAdapter>[0];

/**
 * 取得本模块的 DB 句柄。
 *
 * 只能在处理请求、任务或启动逻辑时调用，不能在模块加载期调用，否则可能早于宿主的
 * `initializeApplicationInfrastructure()`。
 */
export function getIdentityDatabase(): IdentityDatabase {
  return getDatabase<IdentityDatabase>();
}
