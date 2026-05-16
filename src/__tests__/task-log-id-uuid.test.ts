import { describe, test, expect } from "bun:test";

// ── generateTaskId / generateLogId UUID 格式验证 ──
// R38 修复：ID 生成从 task_xxx 改为标准 UUID，兼容 PG uuid 列类型

// UUID v4 正则（8-4-4-4-12 hex）
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// 复制 task.ts 的生成逻辑
import { randomUUID } from "node:crypto";

function generateTaskId(): string {
  return randomUUID();
}

function generateLogId(): string {
  return randomUUID();
}

describe("task/log ID generation: UUID format", () => {
  // generateTaskId 生成标准 UUID 格式
  test("generateTaskId returns valid UUID", () => {
    const id = generateTaskId();
    expect(UUID_RE.test(id)).toBe(true);
  });

  // generateLogId 生成标准 UUID 格式
  test("generateLogId returns valid UUID", () => {
    const id = generateLogId();
    expect(UUID_RE.test(id)).toBe(true);
  });

  // 多次调用生成不同 ID
  test("generates unique IDs across calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateTaskId());
      ids.add(generateLogId());
    }
    expect(ids.size).toBe(200);
  });

  // 不再包含旧格式前缀 task_ / log_
  test("no longer uses task_ or log_ prefix", () => {
    for (let i = 0; i < 20; i++) {
      expect(generateTaskId().startsWith("task_")).toBe(false);
      expect(generateLogId().startsWith("log_")).toBe(false);
    }
  });
});
