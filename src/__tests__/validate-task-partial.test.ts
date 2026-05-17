import { describe, test, expect, mock } from "bun:test";

// ── validateTaskInput 泛型签名（不再需要 as CreateTaskInput） ──

const TEAM_ID = "aaaaaaaa-0000-0000-0000-000000000001";

// 直接 import 纯函数
// validateTaskInput 是模块私有函数，通过间接方式测试
// 但我们可以验证 updateTask 不再需要 cast

// 改为测试 validateTaskInput 通过 createTask 的验证路径
const mockTaskCreate = mock(async (d: any) => d);
const mockTaskGetByTeamAndId = mock(async (): Promise<any> => ({
  id: "task_v1",
  userId: "u1",
  teamId: TEAM_ID,
  name: "test",
  cron: "0 * * * *",
  url: "http://localhost",
  method: "GET",
  headers: null,
  body: null,
  enabled: true,
  lastRunAt: null,
  nextRunAt: null,
  lastStatus: null,
  createdAt: new Date(),
  updatedAt: new Date(),
}));
const mockTaskUpdate = mock(async (): Promise<any> => ({
  id: "task_v1",
  userId: "u1",
  teamId: TEAM_ID,
  name: "updated",
  cron: "0 * * * *",
  url: "http://localhost",
  method: "GET",
  headers: null,
  body: null,
  enabled: true,
  lastRunAt: null,
  nextRunAt: null,
  lastStatus: null,
  createdAt: new Date(),
  updatedAt: new Date(),
}));

mock.module("../repositories/task", () => ({
  scheduledTaskRepo: {
    listByTeam: mock(async () => []),
    getById: mock(async () => null),
    getByTeamAndId: mockTaskGetByTeamAndId,
    create: mockTaskCreate,
    update: mockTaskUpdate,
    deleteByTeamAndId: mock(async () => true),
    listEnabled: mock(async () => []),
  },
  taskExecutionLogRepo: {
    listByTask: mock(async () => []),
    listByTaskPaged: mock(async () => ({ rows: [], total: 0 })),
    create: mock(async () => ({ id: "log_1" })),
    deleteByTask: mock(async () => {}),
  },
}));

mock.module("../logger", () => ({
  log: mock(() => {}),
  error: mock(() => {}),
}));

mock.module("../services/scheduler", () => ({
  scheduleTask: mock(() => {}),
  rescheduleTask: mock(() => {}),
  unscheduleTask: mock(() => {}),
}));

mock.module("../services/config/jsonb", () => ({
  parseJsonb: (v: unknown) => v,
}));

const { updateTask, createTask } = await import("../services/task");

describe("validateTaskInput accepts partial without cast", () => {
  // updateTask 接受 Partial<CreateTaskInput>，不需要提供所有字段
  test("updateTask validates partial data without cast", async () => {
    const result = await updateTask(TEAM_ID, "task_v1", {
      name: "updated",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("updated");
    }
  });

  // 只更新 enabled 字段（不是 CreateTaskInput 的一部分）
  test("updateTask accepts enabled-only update", async () => {
    const result = await updateTask(TEAM_ID, "task_v1", {
      enabled: false,
    });

    expect(result.success).toBe(true);
  });

  // 空对象 update 通过验证（所有字段 undefined）
  test("updateTask accepts empty update", async () => {
    const result = await updateTask(TEAM_ID, "task_v1", {});

    expect(result.success).toBe(true);
  });

  // 部分字段验证：只提供 method
  test("updateTask validates method field only", async () => {
    const result = await updateTask(TEAM_ID, "task_v1", {
      method: "DELETE",
    });

    expect(result.success).toBe(true);
    // 验证 repo.update 收到了正确的 method
    const calls = mockTaskUpdate.mock.calls as any[][];
    const updateArg = calls[calls.length - 1][1];
    expect(updateArg.method).toBe("DELETE");
  });

  // 验证失败：空 method 字符串
  test("updateTask rejects empty method string", async () => {
    const result = await updateTask(TEAM_ID, "task_v1", {
      method: "",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
    }
  });

  // createTask 仍需要完整字段
  test("createTask requires full input", async () => {
    const result = await createTask(TEAM_ID, {
      name: "new-task",
      cron: "*/10 * * * *",
      url: "http://localhost:9999/hook",
      method: "POST",
    });

    expect(result.success).toBe(true);
  });
});
