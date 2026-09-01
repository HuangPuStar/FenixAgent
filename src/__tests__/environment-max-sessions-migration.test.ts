import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { environment } from "../db/schema";

const migrationPath = resolve(import.meta.dir, "../../drizzle/0024_environment-max-sessions.sql");

// Environment schema 默认值必须与服务端默认并发配置保持一致。
test("Environment max_sessions schema 默认值为 5", () => {
  expect(environment.maxSessions.default).toBe(5);
});

// 迁移必须同时调整数据库默认值并回填历史默认值 1，避免已有 Environment 继续被单实例限制。
test("Environment max_sessions 迁移更新默认值并回填历史值", () => {
  const sql = readFileSync(migrationPath, "utf8");

  expect(sql).toContain('ALTER TABLE "environment" ALTER COLUMN "max_sessions" SET DEFAULT 5');
  expect(sql).toContain('UPDATE "environment" SET "max_sessions" = 5 WHERE "max_sessions" = 1');
});

describe("Environment max_sessions 迁移边界", () => {
  // 回填必须带值过滤，不能覆盖管理员已显式配置的其他并发上限。
  test("仅回填历史默认值 1", () => {
    const sql = readFileSync(migrationPath, "utf8");

    expect(sql).toContain('WHERE "max_sessions" = 1');
    expect(sql).not.toContain('UPDATE "environment" SET "max_sessions" = 5;');
  });
});
