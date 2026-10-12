import { getDatabase } from "@fenix/platform-sdk/server";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

/**
 * 公共 Git 仓储使用的 DB 句柄类型。
 *
 * 口径与 `@fenix/resource-task` 一致：刻意不写 `typeof schema`——仓储只用
 * `select` / `insert` / `update`，不使用 `db.query.*` 关系查询，因此不需要耦合 schema 聚合类型
 * （本包四张表定义在 `db/schema.ts`，经 `@fenix/git/db` 出口被仓储直接引用）。
 */
export type GitDatabase = NodePgDatabase<Record<string, never>>;

/**
 * 取得公共 Git 的 DB 句柄。
 *
 * 只能在请求、任务或启动逻辑中调用，不能在模块加载期调用：模块加载可能早于宿主的
 * `initializeApplicationInfrastructure()`，那之前 `getDatabase()` 会抛错。仓储因此不持有模块级
 * db 常量——句柄在事务上下文中还会被平台切换成事务连接，缓存下来会绕过事务边界。
 */
export function getGitDatabase(): GitDatabase {
  return getDatabase<GitDatabase>();
}
