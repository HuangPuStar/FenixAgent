import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── VALID_HTTP_METHODS 常量 + validateTaskInput 集成验证 ──

const mockCreate = mock(async (data: any) => data);
const mockUpdate = mock(async (id: string, data: any) => ({ id, ...data }));

mock.module("../repositories/task", () => ({
  scheduledTaskRepo: {
    create: mockCreate,
    update: mockUpdate,
    getByUserAndId: mock(async () => null),
    deleteByUserAndId: mock(async () => true),
    listByUser: mock(async () => []),
    getById: mock(async () => null),
  },
  taskExecutionLogRepo: {
    create: mock(async () => {}),
    listByTaskPaged: mock(async () => ({ rows: [], total: 0 })),
    deleteByTask: mock(async () => {}),
  },
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

const { createTask, updateTask } = await import("../services/task");

describe("VALID_HTTP_METHODS constant usage", () => {
  beforeEach(() => {
    mockCreate.mockClear();
    mockUpdate.mockClear();
  });

  // PATCH 是有效方法
  test("PATCH method accepted in createTask", async () => {
    const result = await createTask("u1", {
      name: "test",
      cron: "0 * * * *",
      url: "http://example.com",
      method: "PATCH",
    });
    expect(result.success).toBe(true);
  });

  // OPTIONS 是有效方法
  test("OPTIONS method accepted in updateTask", async () => {
    mockUpdate.mockResolvedValueOnce({
      id: "t1", userId: "u1", name: "test", cron: "0 * * * *", timezone: null,
      enabled: true, url: "http://example.com", method: "OPTIONS",
      headers: null, body: null, lastRunAt: null, nextRunAt: null,
      lastStatus: null, createdAt: new Date(), updatedAt: new Date(),
    });

    mockUpdate.mockClear();
    // 先 mock getByUserAndId 返回现有 task
    const { scheduledTaskRepo } = await import("../repositories/task");
    (scheduledTaskRepo.getByUserAndId as typeof mock).mockResolvedValueOnce({
      id: "t1", userId: "u1", name: "test", cron: "0 * * * *", timezone: null,
      enabled: true, url: "http://example.com", method: "GET",
      headers: null, body: null, lastRunAt: null, nextRunAt: null,
      lastStatus: null, createdAt: new Date(), updatedAt: new Date(),
    });
    (scheduledTaskRepo.update as typeof mock).mockResolvedValueOnce({
      id: "t1", userId: "u1", name: "test", cron: "0 * * * *", timezone: null,
      enabled: true, url: "http://example.com", method: "OPTIONS",
      headers: null, body: null, lastRunAt: null, nextRunAt: null,
      lastStatus: null, createdAt: new Date(), updatedAt: new Date(),
    });

    const result = await updateTask("u1", "t1", { method: "OPTIONS" });
    expect(result.success).toBe(true);
  });

  // 无效方法被拒绝
  test("invalid method rejected in createTask", async () => {
    const result = await createTask("u1", {
      name: "test",
      cron: "0 * * * *",
      url: "http://example.com",
      method: "INVALID",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
    }
  });

  // HEAD 是有效方法
  test("HEAD method accepted in createTask", async () => {
    const result = await createTask("u1", {
      name: "test",
      cron: "0 * * * *",
      url: "http://example.com",
      method: "HEAD",
    });
    expect(result.success).toBe(true);
  });
});
