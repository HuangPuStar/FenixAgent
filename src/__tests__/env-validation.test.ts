import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { findDeprecatedEnvVars, validateEnv } from "../env";

// 环境变量校验：必填项缺失时报错
describe("env validation", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.NODE_ENV = "test";
    delete process.env.RCS_HOST;
    delete process.env.RCS_PORT;
    delete process.env.RCS_CORS_ORIGIN;
    delete process.env.RCS_TRUSTED_ORIGINS;
    delete process.env.SKILL_DIR;
    delete process.env.APP_BRAND_NAME;
    delete process.env.APP_LOGO_PATH;
    delete process.env.APP_HIDDEN_SIDEBAR_TABS;
  });

  afterEach(() => {
    process.env = { ...originalEnv } as NodeJS.ProcessEnv;
  });

  test("DATABASE_URL 缺失时校验失败", () => {
    delete process.env.DATABASE_URL;
    delete process.env.RCS_API_KEYS;
    expect(() => validateEnv()).toThrow(/DATABASE_URL/);
  });

  test("RCS_API_KEYS 缺失时校验失败", () => {
    process.env.DATABASE_URL = "postgres://u:p@h:5432/db";
    delete process.env.RCS_API_KEYS;
    expect(() => validateEnv()).toThrow(/RCS_API_KEYS/);
  });

  test("所有必填项存在时校验成功", () => {
    process.env.DATABASE_URL = "postgres://u:p@h:5432/db";
    process.env.RCS_API_KEYS = "test-key-123";
    const env = validateEnv();
    expect(env.DATABASE_URL).toBe("postgres://u:p@h:5432/db");
    expect(env.RCS_API_KEYS).toBe("test-key-123");
  });

  test("可选变量使用默认值", () => {
    process.env.DATABASE_URL = "postgres://u:p@h:5432/db";
    process.env.RCS_API_KEYS = "test-key";
    const env = validateEnv();
    expect(env.RCS_PORT).toBe(3000);
    expect(env.RCS_HOST).toBe("0.0.0.0");
    expect(env.RCS_CORS_ORIGIN).toBe("*");
    expect(env.RCS_TRUSTED_ORIGINS).toBe("");
    expect(env.SKILL_DIR).toBe("./data/skills");
    expect(env.APP_BRAND_NAME).toBe("Fenix");
    expect(env.APP_LOGO_PATH).toBe("");
    expect(env.APP_HIDDEN_SIDEBAR_TABS).toBe("");
  });

  test("PORT 非数字时校验失败", () => {
    process.env.DATABASE_URL = "postgres://u:p@h:5432/db";
    process.env.RCS_API_KEYS = "test-key";
    process.env.RCS_PORT = "not-a-number";
    expect(() => validateEnv()).toThrow(/RCS_PORT/);
  });

  // RCS_DEFAULT_MACHINE_ID 不设置时通过校验（optional）
  test("RCS_DEFAULT_MACHINE_ID 不设置时通过校验", () => {
    process.env.DATABASE_URL = "postgres://u:p@h:5432/db";
    process.env.RCS_API_KEYS = "test-key";
    delete process.env.RCS_DEFAULT_MACHINE_ID;
    const env = validateEnv();
    expect(env.RCS_DEFAULT_MACHINE_ID).toBeUndefined();
  });

  // 设置合法 mach_ 前缀值时应通过校验
  test("RCS_DEFAULT_MACHINE_ID 合法值时通过校验", () => {
    process.env.DATABASE_URL = "postgres://u:p@h:5432/db";
    process.env.RCS_API_KEYS = "test-key";
    process.env.RCS_DEFAULT_MACHINE_ID = "mach_abc123";
    const env = validateEnv();
    expect(env.RCS_DEFAULT_MACHINE_ID).toBe("mach_abc123");
  });

  // 设置非法值（不以 mach_ 开头）时应校验失败
  test("RCS_DEFAULT_MACHINE_ID 不以 mach_ 开头时校验失败", () => {
    process.env.DATABASE_URL = "postgres://u:p@h:5432/db";
    process.env.RCS_API_KEYS = "test-key";
    process.env.RCS_DEFAULT_MACHINE_ID = "invalid-id";
    expect(() => validateEnv()).toThrow(/RCS_DEFAULT_MACHINE_ID/);
  });

  // RCS_DEFAULT_ENGINE_TYPE 合法值
  test("RCS_DEFAULT_ENGINE_TYPE 合法值 'ccb' 通过校验", () => {
    process.env.DATABASE_URL = "postgres://u:p@h:5432/db";
    process.env.RCS_API_KEYS = "test-key";
    process.env.RCS_DEFAULT_ENGINE_TYPE = "ccb";
    const env = validateEnv();
    expect(env.RCS_DEFAULT_ENGINE_TYPE).toBe("ccb");
  });

  // RCS_DEFAULT_ENGINE_TYPE 非法值
  test("RCS_DEFAULT_ENGINE_TYPE 非法值时校验失败", () => {
    process.env.DATABASE_URL = "postgres://u:p@h:5432/db";
    process.env.RCS_API_KEYS = "test-key";
    process.env.RCS_DEFAULT_ENGINE_TYPE = "invalid-engine";
    expect(() => validateEnv()).toThrow(/RCS_DEFAULT_ENGINE_TYPE/);
  });

  // RCS_AGENT_MAX_CONCURRENCY 合法值时应通过校验
  test("RCS_AGENT_MAX_CONCURRENCY 合法值时通过校验", () => {
    process.env.DATABASE_URL = "postgres://u:p@h:5432/db";
    process.env.RCS_API_KEYS = "test-key";
    process.env.RCS_AGENT_MAX_CONCURRENCY = "3";
    const env = validateEnv();
    expect(env.RCS_AGENT_MAX_CONCURRENCY).toBe(3);
  });

  // RCS_USER_AGENT_MAX_CONCURRENCY 合法值时应通过校验
  test("RCS_USER_AGENT_MAX_CONCURRENCY 合法值时通过校验", () => {
    process.env.DATABASE_URL = "postgres://u:p@h:5432/db";
    process.env.RCS_API_KEYS = "test-key";
    process.env.RCS_USER_AGENT_MAX_CONCURRENCY = "2";
    const env = validateEnv();
    expect(env.RCS_USER_AGENT_MAX_CONCURRENCY).toBe(2);
  });

  // 未设置 RCS_USER_AGENT_MAX_CONCURRENCY 时应使用默认值 10
  test("RCS_USER_AGENT_MAX_CONCURRENCY 未设置时使用默认值 10", () => {
    process.env.DATABASE_URL = "postgres://u:p@h:5432/db";
    process.env.RCS_API_KEYS = "test-key";
    delete process.env.RCS_USER_AGENT_MAX_CONCURRENCY;
    const env = validateEnv();
    expect(env.RCS_USER_AGENT_MAX_CONCURRENCY).toBe(10);
  });

  // 未配置连接池变量时必须保留 postgres.js 当前的默认连接策略。
  test("数据库连接池变量未设置时使用默认值", () => {
    process.env.DATABASE_URL = "postgres://u:p@h:5432/db";
    process.env.RCS_API_KEYS = "test-key";
    delete process.env.RCS_DB_POOL_MAX;
    delete process.env.RCS_DB_IDLE_TIMEOUT_SECONDS;
    delete process.env.RCS_DB_CONNECT_TIMEOUT_SECONDS;
    delete process.env.RCS_DB_MAX_LIFETIME_SECONDS;

    const env = validateEnv();
    expect(env.RCS_DB_POOL_MAX).toBe(20);
    expect(env.RCS_DB_IDLE_TIMEOUT_SECONDS).toBeUndefined();
    expect(env.RCS_DB_CONNECT_TIMEOUT_SECONDS).toBeUndefined();
    expect(env.RCS_DB_MAX_LIFETIME_SECONDS).toBeUndefined();
    expect(env.RCS_DB_IDLE_IN_TRANSACTION_TIMEOUT_SECONDS).toBe(150);
    expect(env.RCS_DB_LOCK_TIMEOUT_SECONDS).toBe(5);
  });

  // 显式连接池配置应被转换为数值并透传给运行时数据库客户端。
  test("数据库连接池变量使用显式配置", () => {
    process.env.DATABASE_URL = "postgres://u:p@h:5432/db";
    process.env.RCS_API_KEYS = "test-key";
    process.env.RCS_DB_POOL_MAX = "20";
    process.env.RCS_DB_IDLE_TIMEOUT_SECONDS = "60";
    process.env.RCS_DB_CONNECT_TIMEOUT_SECONDS = "15";
    process.env.RCS_DB_MAX_LIFETIME_SECONDS = "3600";
    process.env.RCS_DB_IDLE_IN_TRANSACTION_TIMEOUT_SECONDS = "90";
    process.env.RCS_DB_LOCK_TIMEOUT_SECONDS = "3";

    expect(validateEnv()).toMatchObject({
      RCS_DB_POOL_MAX: 20,
      RCS_DB_IDLE_TIMEOUT_SECONDS: 60,
      RCS_DB_CONNECT_TIMEOUT_SECONDS: 15,
      RCS_DB_MAX_LIFETIME_SECONDS: 3600,
      RCS_DB_IDLE_IN_TRANSACTION_TIMEOUT_SECONDS: 90,
      RCS_DB_LOCK_TIMEOUT_SECONDS: 3,
    });
  });

  // 所有已设置的连接池变量必须为正整数，避免无效运行时策略。
  test("数据库连接池变量为零时校验失败", () => {
    process.env.DATABASE_URL = "postgres://u:p@h:5432/db";
    process.env.RCS_API_KEYS = "test-key";
    process.env.RCS_DB_POOL_MAX = "0";
    expect(() => validateEnv()).toThrow(/RCS_DB_POOL_MAX/);

    process.env.RCS_DB_POOL_MAX = "10";
    process.env.RCS_DB_CONNECT_TIMEOUT_SECONDS = "0";
    expect(() => validateEnv()).toThrow(/RCS_DB_CONNECT_TIMEOUT_SECONDS/);

    process.env.RCS_DB_CONNECT_TIMEOUT_SECONDS = "30";
    process.env.RCS_DB_IDLE_TIMEOUT_SECONDS = "0";
    expect(() => validateEnv()).toThrow(/RCS_DB_IDLE_TIMEOUT_SECONDS/);

    delete process.env.RCS_DB_IDLE_TIMEOUT_SECONDS;
    process.env.RCS_DB_MAX_LIFETIME_SECONDS = "0";
    expect(() => validateEnv()).toThrow(/RCS_DB_MAX_LIFETIME_SECONDS/);

    delete process.env.RCS_DB_MAX_LIFETIME_SECONDS;
    process.env.RCS_DB_IDLE_IN_TRANSACTION_TIMEOUT_SECONDS = "0";
    expect(() => validateEnv()).toThrow(/RCS_DB_IDLE_IN_TRANSACTION_TIMEOUT_SECONDS/);

    process.env.RCS_DB_IDLE_IN_TRANSACTION_TIMEOUT_SECONDS = "150";
    process.env.RCS_DB_LOCK_TIMEOUT_SECONDS = "0";
    expect(() => validateEnv()).toThrow(/RCS_DB_LOCK_TIMEOUT_SECONDS/);
  });

  // RCS_SCHEDULED_AGENT_MAX_CONCURRENCY 非法值时应校验失败
  test("RCS_SCHEDULED_AGENT_MAX_CONCURRENCY 非法值时校验失败", () => {
    process.env.DATABASE_URL = "postgres://u:p@h:5432/db";
    process.env.RCS_API_KEYS = "test-key";
    process.env.RCS_SCHEDULED_AGENT_MAX_CONCURRENCY = "0";
    expect(() => validateEnv()).toThrow(/RCS_SCHEDULED_AGENT_MAX_CONCURRENCY/);
  });

  // 空串 RCS_DEFAULT_MACHINE_ID（compose ${VAR:-} 空默认值透传）应视为未设置，
  // 而不是触发 mach_ 前缀 regex 校验导致服务拒绝启动（断裂点 1 配套修复）。
  test("RCS_DEFAULT_MACHINE_ID 为空串时视为未设置", () => {
    process.env.DATABASE_URL = "postgres://u:p@h:5432/db";
    process.env.RCS_API_KEYS = "test-key";
    process.env.RCS_DEFAULT_MACHINE_ID = "";
    const env = validateEnv();
    expect(env.RCS_DEFAULT_MACHINE_ID).toBeUndefined();
  });

  // findDeprecatedEnvVars：未设置旧变量时返回空数组，不产生告警
  test("findDeprecatedEnvVars 未设置 RCS_DEFAULT_MACHINE_TYPE 时为空数组", () => {
    delete process.env.RCS_DEFAULT_MACHINE_TYPE;
    expect(findDeprecatedEnvVars()).toEqual([]);
  });

  // findDeprecatedEnvVars：设置 RCS_DEFAULT_MACHINE_TYPE（死配置）时返回替换建议，
  // 供 index.ts 启动告警（断裂点 1 的可见性修复）。
  test("findDeprecatedEnvVars 设置 RCS_DEFAULT_MACHINE_TYPE 时返回替换建议", () => {
    process.env.RCS_DEFAULT_MACHINE_TYPE = "ccb";
    expect(findDeprecatedEnvVars()).toEqual([
      { name: "RCS_DEFAULT_MACHINE_TYPE", replacement: "RCS_DEFAULT_ENGINE_TYPE" },
    ]);
  });
});
