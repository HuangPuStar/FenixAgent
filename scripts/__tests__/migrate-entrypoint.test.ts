import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");

/** 迁移入口的判定必须在源码层钉住：它需要真库与并发副本才能端到端复现，不在单测里起容器。 */
function readMigrateEntrypoint(): string {
  return readFileSync(resolve(repoRoot, "scripts/migrate.ts"), "utf8");
}

describe("DDL 迁移入口守卫", () => {
  // 任何迁移失败都必须以非 0 退出：不得再按错误 message 的子串把异常改写成成功。
  // 注释里保留这段历史说明（「为什么不能再用它」），因此只禁止代码中的子串判定与成功退出。
  test("不再把 already exists 异常当作成功", () => {
    const source = readMigrateEntrypoint();
    expect(source).not.toMatch(/includes\(\s*["'`]already exists/);
    expect(source).not.toContain("process.exitCode = 0");
  });

  // 多副本并发 DDL 是「撞 already exists」的真实诱因，用常量 advisory lock key 串行化。
  test("用 advisory lock 串行化并发迁移", () => {
    const source = readMigrateEntrypoint();
    expect(source).toContain("pg_advisory_lock");
    expect(source).toContain("pg_advisory_unlock");
  });

  // 连接串与口令不得写入源码：缺 DATABASE_URL 时必须失败退出，不得回退到本地默认连接串。
  test("缺少 DATABASE_URL 时失败退出且不回显取值", () => {
    const source = readMigrateEntrypoint();
    expect(source).not.toContain("postgres://");
    expect(source).toContain("DATABASE_URL");
  });

  // 口令不得进入流水线日志：通用脱敏设施已随 4e03cc72b 整批撤回，本入口就地掩掉连接串原文与其中的口令段。
  test("错误诊断掩掉连接串与口令段", async () => {
    const { maskDatabaseUrlSecrets } = await import("../../scripts/migrate");
    const url = "postgres://user:fixture-password@db.internal:5432/app";
    const masked = maskDatabaseUrlSecrets(`TypeError: Invalid URL: ${url}\npassword=fixture-password`, url);
    expect(masked).not.toContain("fixture-password");
    expect(masked).toContain("postgres://***:***@db.internal:5432/app");
    expect(masked).toContain("password=***");
  });
});
