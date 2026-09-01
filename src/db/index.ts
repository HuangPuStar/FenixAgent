import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { type DatabaseConnectionPoolConfig, parseDatabaseConnectionPoolConfig } from "../env";
import * as schema from "./schema";

const DATABASE_URL = process.env.DATABASE_URL || "postgres://rcs:rcs@localhost:5432/rcs";
const poolConfig = parseDatabaseConnectionPoolConfig();

/** 将已校验的项目连接池配置映射为 postgres.js client options。 */
export function buildDatabaseConnectionOptions(poolConfig: DatabaseConnectionPoolConfig): {
  max?: number;
  connect_timeout?: number;
  idle_timeout?: number;
  max_lifetime?: number;
} {
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
  };
}

export const client = postgres(DATABASE_URL, buildDatabaseConnectionOptions(poolConfig));
export const db = drizzle(client, { schema });

export async function initDb() {
  await client`SELECT 1`;
}
