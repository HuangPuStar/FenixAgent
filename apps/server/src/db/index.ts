import { createLogger, type Logger } from "@fenix/logger";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import { type DatabaseConnectionPoolConfig, parseDatabaseConnectionPoolConfig } from "../env";
import * as schema from "./schema";

const DATABASE_URL = process.env.DATABASE_URL || "postgres://rcs:rcs@localhost:5432/rcs";
const poolConfig = parseDatabaseConnectionPoolConfig();
const logger = createLogger("db");

interface PoolErrorEmitter {
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "connect", listener: (client: ClientErrorEmitter) => void): unknown;
}

interface ClientErrorEmitter {
  on(event: "error", listener: (error: Error) => void): unknown;
}

/** 将已校验的项目连接池配置映射为 pg Pool options。 */
export function buildDatabasePoolOptions(poolConfig: DatabaseConnectionPoolConfig): PoolConfig {
  return {
    ...(poolConfig.RCS_DB_POOL_MAX !== undefined ? { max: poolConfig.RCS_DB_POOL_MAX } : {}),
    ...(poolConfig.RCS_DB_IDLE_TIMEOUT_SECONDS !== undefined
      ? { idleTimeoutMillis: poolConfig.RCS_DB_IDLE_TIMEOUT_SECONDS * 1_000 }
      : {}),
    ...(poolConfig.RCS_DB_CONNECT_TIMEOUT_SECONDS !== undefined
      ? { connectionTimeoutMillis: poolConfig.RCS_DB_CONNECT_TIMEOUT_SECONDS * 1_000 }
      : {}),
    ...(poolConfig.RCS_DB_MAX_LIFETIME_SECONDS !== undefined
      ? { maxLifetimeSeconds: poolConfig.RCS_DB_MAX_LIFETIME_SECONDS }
      : {}),
    // PostgreSQL 对未带单位的数值按毫秒解释；配置契约使用秒。
    options: `-c idle_in_transaction_session_timeout=${poolConfig.RCS_DB_IDLE_IN_TRANSACTION_TIMEOUT_SECONDS}s -c lock_timeout=${poolConfig.RCS_DB_LOCK_TIMEOUT_SECONDS}s`,
  };
}

/**
 * 监听 pg Pool 及其 client 发出的错误，避免 EventEmitter 将未处理错误升级为进程异常。
 *
 * Pool 只会转发归还后空闲 client 的错误；借出中的 client 必须单独注册 listener。
 * 连接池会移除故障连接并在后续请求中按需重建；这里保留诊断上下文而不吞掉请求错误。
 */
export function attachDatabasePoolErrorLogger(
  pool: PoolErrorEmitter,
  poolLogger: Pick<Logger, "error"> = logger,
): void {
  pool.on("error", (error) => {
    poolLogger.error("Database pool idle client error", { err: error });
  });
  pool.on("connect", (databaseClient) => {
    databaseClient.on("error", (error) => {
      poolLogger.error("Database client error", { err: error });
    });
  });
}

export const client = new Pool({ connectionString: DATABASE_URL, ...buildDatabasePoolOptions(poolConfig) });
attachDatabasePoolErrorLogger(client);

export const db = drizzle(client, { schema });

export async function initDb() {
  await client.query("SELECT 1");
}
