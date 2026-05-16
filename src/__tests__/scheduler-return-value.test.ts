// 测试 scheduleTask 返回 boolean 表示调度成功/失败
import { describe, test, expect, mock, beforeEach } from "bun:test";

// mock node-schedule
const mockScheduleJob = mock(() => ({ cancel: mock(() => {}) }));
const mockCancelJob = mock(() => {});

mock.module("node-schedule", () => ({
  default: {
    scheduleJob: mockScheduleJob,
  },
}));

// mock repository — 返回空列表避免启动时查询
mock.module("../repositories/task", () => ({
  scheduledTaskRepo: {
    listEnabled: mock(async () => []),
    update: mock(async () => ({})),
  },
  taskExecutionLogRepo: {},
}));

mock.module("./task", () => ({
  createExecutionLog: mock(async () => "log_1"),
  getTaskById: mock(async () => null),
  executeTaskById: mock(async () => ({ success: true, data: {} })),
}));

const { scheduleTask, rescheduleTask } = await import("../services/scheduler");

describe("scheduleTask return value", () => {
  beforeEach(() => {
    mockScheduleJob.mockClear();
  });

  test("returns true when job is created successfully", () => {
    mockScheduleJob.mockImplementation(() => ({ cancel: mock(() => {}), nextInvocation: () => new Date() }));
    const result = scheduleTask({ id: "task_1", cron: "* * * * *", enabled: true });
    expect(result).toBe(true);
  });

  test("returns true for disabled task (no-op)", () => {
    const result = scheduleTask({ id: "task_2", cron: "* * * * *", enabled: false });
    expect(result).toBe(true);
  });

  test("returns false when node-schedule rejects cron expression", () => {
    // node-schedule returns null for invalid cron
    mockScheduleJob.mockImplementation(() => null);
    const result = scheduleTask({ id: "task_3", cron: "invalid-cron", enabled: true });
    expect(result).toBe(false);
  });

  test("returns true when timezone provided and job created", () => {
    mockScheduleJob.mockImplementation(() => ({ cancel: mock(() => {}), nextInvocation: () => new Date() }));
    const result = scheduleTask({ id: "task_4", cron: "0 * * * *", timezone: "Asia/Shanghai", enabled: true });
    expect(result).toBe(true);
  });
});
