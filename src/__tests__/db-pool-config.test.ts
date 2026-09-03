import { describe, expect, test } from "bun:test";
import { attachDatabasePoolErrorLogger, buildDatabasePoolOptions } from "../db";
import { parseDatabaseConnectionPoolConfig } from "../env";

type DatabaseClientErrorListener = (error: Error) => void;
type DatabasePoolConnectListener = (client: DatabaseClientErrorEmitter) => void;

class DatabaseClientErrorEmitter {
  listener: DatabaseClientErrorListener | undefined;

  on(event: "error", listener: DatabaseClientErrorListener): unknown {
    expect(event).toBe("error");
    this.listener = listener;
    return this;
  }
}

class DatabasePoolErrorEmitter {
  errorListener: DatabaseClientErrorListener | undefined;
  connectListener: DatabasePoolConnectListener | undefined;

  on(event: "error", listener: DatabaseClientErrorListener): unknown;
  on(event: "connect", listener: DatabasePoolConnectListener): unknown;
  on(event: "error" | "connect", listener: DatabaseClientErrorListener | DatabasePoolConnectListener): unknown {
    if (event === "error") {
      this.errorListener = listener as DatabaseClientErrorListener;
      return this;
    }
    this.connectListener = listener as DatabasePoolConnectListener;
    return this;
  }
}

describe("database connection pool config", () => {
  // 未设置时使用项目约定的连接池与数据库保护默认值。
  test("未设置时使用项目默认连接池配置", () => {
    const config = parseDatabaseConnectionPoolConfig({});

    expect(config.RCS_DB_POOL_MAX).toBe(20);
    expect(config.RCS_DB_IDLE_TIMEOUT_SECONDS).toBe(60);
    expect(config.RCS_DB_CONNECT_TIMEOUT_SECONDS).toBe(30);
    expect(config.RCS_DB_MAX_LIFETIME_SECONDS).toBe(3600);
    expect(config.RCS_DB_IDLE_IN_TRANSACTION_TIMEOUT_SECONDS).toBe(150);
    expect(config.RCS_DB_LOCK_TIMEOUT_SECONDS).toBe(5);
  });

  // 默认秒级配置映射为 pg Pool 单位，PostgreSQL 会话参数保留明确的秒单位。
  test("未设置时传递项目默认连接池配置", () => {
    const options = buildDatabasePoolOptions(parseDatabaseConnectionPoolConfig({}));

    expect(options).toEqual({
      max: 20,
      idleTimeoutMillis: 60_000,
      connectionTimeoutMillis: 30_000,
      maxLifetimeSeconds: 3600,
      options: "-c idle_in_transaction_session_timeout=150s -c lock_timeout=5s",
    });
  });

  // 显式秒级超时转换为 pg Pool 所需的单位，会话参数通过 startup options 传递。
  test("显式超时映射为 pg Pool 连接选项", () => {
    const options = buildDatabasePoolOptions({
      RCS_DB_POOL_MAX: 20,
      RCS_DB_IDLE_TIMEOUT_SECONDS: 60,
      RCS_DB_CONNECT_TIMEOUT_SECONDS: 15,
      RCS_DB_MAX_LIFETIME_SECONDS: 3600,
      RCS_DB_IDLE_IN_TRANSACTION_TIMEOUT_SECONDS: 90,
      RCS_DB_LOCK_TIMEOUT_SECONDS: 3,
    });
    expect(options).toEqual({
      max: 20,
      idleTimeoutMillis: 60_000,
      connectionTimeoutMillis: 15_000,
      maxLifetimeSeconds: 3600,
      options: "-c idle_in_transaction_session_timeout=90s -c lock_timeout=3s",
    });
  });

  // 空闲连接报错必须被 Pool 监听并记录，避免 EventEmitter 将其升级为进程异常。
  test("记录空闲连接错误", () => {
    const logged: unknown[][] = [];
    const pool = new DatabasePoolErrorEmitter();

    attachDatabasePoolErrorLogger(pool, { error: (...args: unknown[]) => logged.push(args) });

    const error = new Error("connection reset");
    pool.errorListener?.(error);

    expect(logged).toEqual([["Database pool idle client error", { err: error }]]);
  });

  // 借出中的连接被数据库终止后，仍必须记录错误，避免未处理的 EventEmitter error 退出进程。
  test("记录借出连接错误", () => {
    const logged: unknown[][] = [];
    const pool = new DatabasePoolErrorEmitter();

    attachDatabasePoolErrorLogger(pool, { error: (...args: unknown[]) => logged.push(args) });

    const client = new DatabaseClientErrorEmitter();
    pool.connectListener?.(client);
    const error = new Error("connection terminated unexpectedly");
    client.listener?.(error);

    expect(logged).toEqual([["Database client error", { err: error }]]);
  });
});
