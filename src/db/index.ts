import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { type DatabaseConnectionPoolConfig, parseDatabaseConnectionPoolConfig } from "../env";
import * as schema from "./schema";

const DATABASE_URL = process.env.DATABASE_URL || "postgres://rcs:rcs@localhost:5432/rcs";
const poolConfig = parseDatabaseConnectionPoolConfig();

/**
 * 将带单位的 PostgreSQL GUC 写入 startup 参数。
 *
 * postgres.js 将这两个已知 GUC 的声明收窄为 number，但 PostgreSQL 对裸数字
 * 按毫秒解释；通过其通用 startup 参数索引传递显式单位以保持秒级配置契约。
 */
function setPostgresStartupParameter(
  parameters: Partial<postgres.ConnectionParameters>,
  name: string,
  value: string,
): void {
  parameters[name] = value;
}

/** 将已校验的项目连接池配置映射为 postgres.js client options。 */
export function buildDatabaseConnectionOptions(poolConfig: DatabaseConnectionPoolConfig): {
  max?: number;
  connect_timeout?: number;
  idle_timeout?: number;
  max_lifetime?: number;
  connection: Partial<postgres.ConnectionParameters>;
} {
  const connection: Partial<postgres.ConnectionParameters> = {};

  setPostgresStartupParameter(
    connection,
    "idle_in_transaction_session_timeout",
    `${poolConfig.RCS_DB_IDLE_IN_TRANSACTION_TIMEOUT_SECONDS}s`,
  );
  setPostgresStartupParameter(connection, "lock_timeout", `${poolConfig.RCS_DB_LOCK_TIMEOUT_SECONDS}s`);

  return {
    ...(poolConfig.RCS_DB_POOL_MAX !== undefined ? { max: poolConfig.RCS_DB_POOL_MAX } : {}),
    ...(poolConfig.RCS_DB_IDLE_TIMEOUT_SECONDS !== undefined
      ? { idle_timeout: poolConfig.RCS_DB_IDLE_TIMEOUT_SECONDS }
      : {}),
    ...(poolConfig.RCS_DB_CONNECT_TIMEOUT_SECONDS !== undefined
      ? { connect_timeout: poolConfig.RCS_DB_CONNECT_TIMEOUT_SECONDS }
      : {}),
    ...(poolConfig.RCS_DB_MAX_LIFETIME_SECONDS !== undefined
      ? { max_lifetime: poolConfig.RCS_DB_MAX_LIFETIME_SECONDS }
      : {}),
    connection,
  };
}

export const client = postgres(DATABASE_URL, buildDatabaseConnectionOptions(poolConfig));
export const db = drizzle(client, { schema });

export async function initDb() {
  await client`SELECT 1`;
}
