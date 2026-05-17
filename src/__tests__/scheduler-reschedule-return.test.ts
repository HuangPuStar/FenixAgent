// ── scheduler rescheduleTask 返回 boolean（与 scheduleTask 对齐） ──
import { describe, test, expect, mock, beforeEach } from "bun:test";

// mock node-schedule，在 import scheduler 之前注册
mock.module("node-schedule", () => ({
  default: {
    scheduleJob: mock(() => ({ nextInvocation: () => null, cancel: mock() })),
  },
}));
mock.module("../repositories/task", () => ({
  scheduledTaskRepo: { update: mock(async () => {}) },
  taskExecutionLogRepo: {
    listByTask: mock(async () => []),
    listByTaskPaged: mock(async () => ({ rows: [], total: 0 })),
    create: mock(async () => ({ id: "log_1" })),
    deleteByTask: mock(async () => {}),
  },
}));
mock.module("../logger", () => ({
  log: mock(),
  error: mock(),
}));
mock.module("./task", () => ({
  createExecutionLog: mock(async () => "log-id"),
  executeTaskById: mock(async () => ({ success: true })),
  getTaskById: mock(async () => null),
}));

const { scheduleTask, rescheduleTask, unscheduleTask } = await import("../services/scheduler");

beforeEach(() => {
  // 清除所有活跃 job
  try { unscheduleTask("__test_1"); unscheduleTask("__test_2"); } catch {}
});

describe("rescheduleTask returns boolean", () => {
  // rescheduleTask 委托 scheduleTask，应传播返回值
  test("returns true when scheduleTask succeeds", () => {
    const result = rescheduleTask({
      id: "__test_1",
      cron: "*/5 * * * *",
      timezone: null,
      enabled: true,
    });
    expect(result).toBe(true);
    unscheduleTask("__test_1");
  });

  // disabled task 不调度但返回 true（与 scheduleTask 一致）
  test("returns true for disabled task (no-op)", () => {
    const result = rescheduleTask({
      id: "__test_2",
      cron: "*/5 * * * *",
      timezone: null,
      enabled: false,
    });
    expect(result).toBe(true);
  });

  // scheduleTask 和 rescheduleTask 对 enabled=false 行为一致
  test("scheduleTask returns true for disabled task", () => {
    const result = scheduleTask({
      id: "__test_disabled",
      cron: "*/5 * * * *",
      enabled: false,
    });
    expect(result).toBe(true);
  });
});
