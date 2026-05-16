import { describe, test, expect, mock } from "bun:test";

// ── executeTaskById timeout detection (AbortError + TimeoutError) 验证 ──

const mockLogCreate = mock(async () => {});
const mockTaskUpdate = mock(async () => ({ id: "t1" }));
const mockFetch = mock(async () => { throw new DOMException("The operation was aborted", "AbortError"); });

// 存储原始 fetch
const originalFetch = globalThis.fetch;

mock.module("../repositories/task", () => ({
  scheduledTaskRepo: { update: mockTaskUpdate, getById: mock(async () => null), listByUser: mock(async () => []) },
  taskExecutionLogRepo: { create: mockLogCreate, listByTaskPaged: mock(async () => ({ rows: [], total: 0 })), deleteByTask: mock(async () => {}) },
}));

mock.module("../services/scheduler", () => ({
  scheduleTask: mock(() => {}),
  rescheduleTask: mock(() => {}),
  unscheduleTask: mock(() => {}),
}));

mock.module("../services/config/jsonb", () => ({
  parseJsonb: (v: unknown) => v,
}));

mock.module("../logger", () => ({
  log: mock(() => {}),
  error: mock(() => {}),
}));

const { executeTaskById } = await import("../services/task");

describe("executeTaskById timeout detection", () => {
  test("detects AbortError as timeout", async () => {
    globalThis.fetch = mock(async () => { throw new DOMException("aborted", "AbortError"); });

    const result = await executeTaskById("t1", "manual", {
      id: "t1", userId: "u1", name: "test", cron: "* * * * *", timezone: null,
      enabled: true, url: "http://example.com", method: "GET",
      headers: null, body: null, lastRunAt: null, nextRunAt: null,
      lastStatus: null, createdAt: new Date(), updatedAt: new Date(),
    } as any);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("timeout");
    }

    globalThis.fetch = originalFetch;
  });

  test("detects TimeoutError as timeout", async () => {
    globalThis.fetch = mock(async () => { throw new DOMException("timeout", "TimeoutError"); });

    const result = await executeTaskById("t1", "manual", {
      id: "t1", userId: "u1", name: "test", cron: "* * * * *", timezone: null,
      enabled: true, url: "http://example.com", method: "GET",
      headers: null, body: null, lastRunAt: null, nextRunAt: null,
      lastStatus: null, createdAt: new Date(), updatedAt: new Date(),
    } as any);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("timeout");
    }

    globalThis.fetch = originalFetch;
  });

  test("generic error is not timeout", async () => {
    globalThis.fetch = mock(async () => { throw new Error("connection refused"); });

    const result = await executeTaskById("t1", "manual", {
      id: "t1", userId: "u1", name: "test", cron: "* * * * *", timezone: null,
      enabled: true, url: "http://example.com", method: "GET",
      headers: null, body: null, lastRunAt: null, nextRunAt: null,
      lastStatus: null, createdAt: new Date(), updatedAt: new Date(),
    } as any);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("failed");
    }

    globalThis.fetch = originalFetch;
  });
});
