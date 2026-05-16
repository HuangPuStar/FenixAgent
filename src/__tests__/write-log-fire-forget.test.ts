import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── writeLogAndReturn fire-and-forget 状态更新验证 ──

const mockLogCreate = mock(async (): Promise<any> => ({}));
const mockTaskUpdate = mock(async (): Promise<any> => null);

mock.module("../repositories/task", () => ({
  scheduledTaskRepo: {
    listByUser: mock(async () => []),
    getById: mock(async () => null),
    getByUserAndId: mock(async () => null),
    create: mock(async (d: any) => d),
    update: mockTaskUpdate,
    deleteByUserAndId: mock(async () => true),
    listEnabled: mock(async () => []),
  },
  taskExecutionLogRepo: {
    listByTask: mock(async () => []),
    listByTaskPaged: mock(async () => ({ rows: [], total: 0 })),
    create: mockLogCreate,
    deleteByTask: mock(async () => {}),
  },
}));

mock.module("../logger", () => ({
  log: mock(() => {}),
  error: mock(() => {}),
}));

mock.module("../services/config/jsonb", () => ({
  parseJsonb: (v: unknown) => v,
}));

mock.module("node-schedule", () => ({
  default: {
    scheduleJob: mock(() => ({ nextInvocation: () => new Date(), cancel: () => {} })),
  },
}));

const { executeTaskById } = await import("../services/task");

describe("writeLogAndReturn fire-and-forget status update", () => {
  beforeEach(() => {
    mockLogCreate.mockClear();
    mockTaskUpdate.mockClear();
  });

  // 状态更新不阻塞返回：update 永不 resolve 时函数仍立即返回
  test("returns without waiting for status update to complete", async () => {
    let updateResolved = false;
    mockTaskUpdate.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 200));
      updateResolved = true;
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => ({
      ok: true,
      status: 200,
      text: async () => "OK",
    })) as unknown as typeof fetch;

    const start = Date.now();
    const result = await executeTaskById("task_ff1", "manual", {
      id: "task_ff1",
      url: "http://localhost:9999/test",
      method: "POST",
      headers: null,
      enabled: true,
    } as any);
    const elapsed = Date.now() - start;

    // 函数在状态更新完成前返回（<100ms，远小于 200ms 的 update 延迟）
    expect(result.success).toBe(true);
    expect(elapsed).toBeLessThan(100);

    globalThis.fetch = origFetch;
  });

  // 状态更新失败不影响返回值
  test("tolerates status update rejection", async () => {
    mockTaskUpdate.mockRejectedValueOnce(new Error("DB down"));

    const origFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => ({
      ok: true,
      status: 200,
      text: async () => "done",
    })) as unknown as typeof fetch;

    const result = await executeTaskById("task_ff2", "cron", {
      id: "task_ff2",
      url: "http://localhost:9999/test",
      method: "GET",
      headers: null,
      enabled: true,
    } as any);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("success");
    }

    globalThis.fetch = origFetch;
  });

  // 日志写入失败仍返回 WRITE_ERROR（不受 fire-and-forget 影响）
  test("log creation failure still returns WRITE_ERROR", async () => {
    mockLogCreate.mockRejectedValueOnce(new Error("log DB down"));

    const origFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => ({
      ok: true,
      status: 200,
      text: async () => "OK",
    })) as unknown as typeof fetch;

    const result = await executeTaskById("task_ff3", "manual", {
      id: "task_ff3",
      url: "http://localhost:9999/test",
      method: "POST",
      headers: null,
      enabled: true,
    } as any);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("WRITE_ERROR");
    }

    globalThis.fetch = origFetch;
  });
});
