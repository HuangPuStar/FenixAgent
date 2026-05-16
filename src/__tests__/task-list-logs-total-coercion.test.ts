// 测试 listExecutionLogs total 字段的 Number() 防御性转换
import { describe, test, expect, mock } from "bun:test";

const mockListByTaskPaged = mock(async () => ({ rows: [], total: "42" })) as any;

mock.module("../repositories/task", () => ({
  scheduledTaskRepo: {},
  taskExecutionLogRepo: {
    listByTaskPaged: mockListByTaskPaged,
  },
}));

mock.module("../services/scheduler", () => ({
  scheduleTask: mock(() => true),
  rescheduleTask: mock(() => {}),
  unscheduleTask: mock(() => {}),
}));

mock.module("../services/config/jsonb", () => ({
  parseJsonb: (v: any) => v,
}));

const { listExecutionLogs } = await import("../services/task");

describe("listExecutionLogs total Number coercion", () => {
  test("coerces string total from PG to number", async () => {
    mockListByTaskPaged.mockImplementation(async () => ({ rows: [], total: "42" }));
    const result = await listExecutionLogs("task_1");
    expect(result.data.total).toBe(42);
    expect(typeof result.data.total).toBe("number");
  });

  test("passes through numeric total unchanged", async () => {
    mockListByTaskPaged.mockImplementation(async () => ({ rows: [], total: 7 }));
    const result = await listExecutionLogs("task_1");
    expect(result.data.total).toBe(7);
    expect(typeof result.data.total).toBe("number");
  });

  test("handles zero total", async () => {
    mockListByTaskPaged.mockImplementation(async () => ({ rows: [], total: 0 }));
    const result = await listExecutionLogs("task_1");
    expect(result.data.total).toBe(0);
  });
});
