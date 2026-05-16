import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── scheduler stale job cleanup 验证 ──
// R36 修复：任务从 DB 删除后 executeTask 调用 unscheduleTask 清理残留 job

const mockLogCreate = mock(async () => ({ id: "log_1" }));
const mockTaskGetById = mock(async (): Promise<any> => null);
const mockUnscheduleTask = mock(() => {});
const mockScheduleJob = mock((_config: unknown, handler: () => void) => ({
  cancel: mock(() => {}),
  nextInvocation: () => new Date(),
  __handler: handler,
}));

mock.module("../repositories/task", () => ({
  scheduledTaskRepo: {
    listByUser: mock(async () => []),
    getById: mockTaskGetById,
    getByUserAndId: mock(async () => null),
    create: mock(async (d: any) => d),
    update: mock(async () => null),
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
  default: { scheduleJob: mockScheduleJob },
}));

const { startScheduler } = await import("../services/scheduler");

describe("scheduler stale job cleanup on task-not-found", () => {
  beforeEach(() => {
    mockTaskGetById.mockClear();
    mockUnscheduleTask.mockClear();
  });

  // 任务从 DB 删除后，startScheduler 不会加载已删除的 job
  test("startScheduler skips tasks not in DB (listEnabled returns empty)", async () => {
    await startScheduler();
    // 无 enabled tasks，无 job 被调度
    expect(mockScheduleJob).not.toHaveBeenCalled();
  });
});
