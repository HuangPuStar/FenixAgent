/**
 * 迁移 runner 伪代码。
 *
 * 真实实现执行 CE/db/migrations，并使用 __drizzle_migrations_ce 记录；不执行 EE migration。
 */
export const CE_MIGRATION_JOURNAL = "__drizzle_migrations_ce";
