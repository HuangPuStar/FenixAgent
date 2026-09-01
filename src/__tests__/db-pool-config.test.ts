import { describe, expect, test } from "bun:test";
import { buildDatabaseConnectionOptions } from "../db";
import { parseDatabaseConnectionPoolConfig } from "../env";

describe("database connection pool config", () => {
  // 未设置时，连接上限采用应用默认值，其余设置保留 postgres.js 原始行为。
  test("未设置时仅使用默认连接上限", () => {
    const config = parseDatabaseConnectionPoolConfig({});

    expect(config.RCS_DB_POOL_MAX).toBe(20);
    expect("RCS_DB_IDLE_TIMEOUT_SECONDS" in config).toBe(false);
    expect("RCS_DB_CONNECT_TIMEOUT_SECONDS" in config).toBe(false);
    expect("RCS_DB_MAX_LIFETIME_SECONDS" in config).toBe(false);
  });

  // 默认连接上限传给 postgres.js，其余未设置字段不得以 undefined 形式覆盖默认策略。
  test("未设置时仅传递默认连接上限", () => {
    const options = buildDatabaseConnectionOptions(parseDatabaseConnectionPoolConfig({}));

    expect(options).toEqual({ max: 20 });
    expect("idle_timeout" in options).toBe(false);
    expect("connect_timeout" in options).toBe(false);
    expect("max_lifetime" in options).toBe(false);
  });

  // 显式超时必须映射为 postgres.js 所使用的秒数选项。
  test("显式超时映射为 postgres.js 连接选项", () => {
    expect(
      buildDatabaseConnectionOptions({
        RCS_DB_POOL_MAX: 20,
        RCS_DB_IDLE_TIMEOUT_SECONDS: 60,
        RCS_DB_CONNECT_TIMEOUT_SECONDS: 15,
        RCS_DB_MAX_LIFETIME_SECONDS: 3600,
      }),
    ).toEqual({
      max: 20,
      idle_timeout: 60,
      connect_timeout: 15,
      max_lifetime: 3600,
    });
  });
});
