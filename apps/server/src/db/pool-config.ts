import { createLogger, type Logger } from "@fenix/logger";
import type { PoolConfig } from "pg";
import type { DatabaseConnectionPoolConfig } from "../env";

/**
 * pg 连接池的配置映射与错误接线（无副作用叶子模块）。
 *
 * 从 `./index` 拆出的原因（阶段 2 任务 1.4 W6a，2026-09-21）：`./index` 在模块加载期就
 * `new Pool()` 并读取 `DATABASE_URL`，测试 preload（`test-utils/setup-mocks.ts`）因此用替身整体
 * 顶掉 `../db`，而替身只提供 `db` / `client` / `initDb`。`db-pool-config.test.ts` 断言的是这两个
 * 函数的映射与监听语义，替身会让断言失去判别力，所以把纯逻辑放在这里，用例直接向实现方取。
 */

// 与拆分前同名，保持日志类别不变。
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
