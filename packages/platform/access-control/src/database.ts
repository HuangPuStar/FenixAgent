import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

/**
 * 授权实现所需的 Drizzle 句柄。
 *
 * 只使用通用的 `select` / `update` 查询面，因此不绑定具体驱动（node-postgres、pg-proxy 等）
 * 与 schema 类型；宿主把自己的进程级 DB client 注入进来。
 */
export type AccessControlDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** 未注册的资源类型必须直接报错：静默返回空会让列表退化为"什么都看不到"。 */
export function isMissingScopeStoreBinding(resourceType: string): Error {
  return new Error(`资源 ${resourceType} 未注册存储绑定，无法解析归属范围`);
}
