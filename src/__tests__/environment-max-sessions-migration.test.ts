import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { environment } from "../db/schema";

describe("Environment 并发限制移除边界", () => {
  // 防回归：Environment schema 不得重新引入 max_sessions；并发配额统一由宿主 agent-concurrency reservation 管理。
  test("schema 不包含 maxSessions 且 0025 仅删除对应列", () => {
    expect("maxSessions" in environment).toBe(false);
    const sql = readFileSync(
      resolve(import.meta.dir, "../../drizzle/0025_remove-environment-max-sessions.sql"),
      "utf8",
    );
    expect(sql.trim()).toBe('ALTER TABLE "environment" DROP COLUMN "max_sessions";');
  });
});
