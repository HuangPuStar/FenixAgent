import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { validateEnv } from "../env";

// 环境变量校验：必填项缺失时报错
describe("env validation", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.NODE_ENV = "test";
    delete process.env.RCS_HOST;
    delete process.env.RCS_PORT;
    delete process.env.RCS_S3_ENABLED;
    delete process.env.SKILL_DIR;
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
    expect(env.RCS_S3_ENABLED).toBe(false);
    expect(env.SKILL_DIR).toBe("./data/skills");
  });

  test("PORT 非数字时校验失败", () => {
    process.env.DATABASE_URL = "postgres://u:p@h:5432/db";
    process.env.RCS_API_KEYS = "test-key";
    process.env.RCS_PORT = "not-a-number";
    expect(() => validateEnv()).toThrow(/RCS_PORT/);
  });
});
