import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── updateTask 使用 repo.update 返回值（消除冗余 getById 查询）──

const TEAM_ID = "aaaaaaaa-0000-0000-0000-000000000001";

const mockTaskUpdate = mock(async (): Promise<any> => ({
  id: "task_up1",
  userId: "u1",
  teamId: TEAM_ID,
  name: "updated-task",
  description: "updated desc",
  cron: "*/5 * * * *",
  timezone: null,
  enabled: true,
  url: "http://localhost:9999/updated",
  method: "POST",
  headers: null,
  body: null,
  lastRunAt: null,
  nextRunAt: null,
  lastStatus: null,
  createdAt: new Date(),
  updatedAt: new Date(),
}));

const mockTaskGetByTeamAndId = mock(async (): Promise<any> => ({
  id: "task_up1",
  userId: "u1",
  teamId: TEAM_ID,
  name: "old-task",
  description: null,
  cron: "0 * * * *",
  timezone: null,
  enabled: true,
  url: "http://localhost:9999/old",
  method: "GET",
  headers: null,
  body: null,
  lastRunAt: null,
  nextRunAt: null,
  lastStatus: null,
  createdAt: new Date(),
  updatedAt: new Date(),
}));

const mockTaskGetById = mock(async (): Promise<any> => null);

mock.module("../repositories/task", () => ({
  scheduledTaskRepo: {
    listByTeam: mock(async () => []),
    getById: mockTaskGetById,
    getByTeamAndId: mockTaskGetByTeamAndId,
    create: mock(async (d: any) => d),
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

const { updateTask } = await import("../services/task");

describe("updateTask uses repo.update return value", () => {
  beforeEach(() => {
    mockTaskUpdate.mockClear();
    mockTaskGetByTeamAndId.mockClear();
    mockTaskGetById.mockClear();
  });

  // updateTask 应使用 repo.update 的返回值，不再调用 getById
  test("does not call getById after update (uses repo.update return)", async () => {
    const result = await updateTask(TEAM_ID, "task_up1", {
      name: "updated-task",
      description: "updated desc",
      cron: "*/5 * * * *",
      url: "http://localhost:9999/updated",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("updated-task");
      expect(result.data.cron).toBe("*/5 * * * *");
    }

    // getByTeamAndId 被调用一次（所有权检查）
    expect(mockTaskGetByTeamAndId).toHaveBeenCalledTimes(1);
    // update 被调用一次
    expect(mockTaskUpdate).toHaveBeenCalledTimes(1);
    // getById 不应被调用（使用 update 返回值）
    expect(mockTaskGetById).not.toHaveBeenCalled();
  });

  // updateTask 在 repo.update 返回 null 时返回 NOT_FOUND
  test("returns NOT_FOUND when repo.update returns null", async () => {
    mockTaskUpdate.mockResolvedValueOnce(null);

    const result = await updateTask(TEAM_ID, "task_missing", { name: "x" });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  // updateTask 正确传递所有字段到 repo.update
  test("passes correct update fields to repo", async () => {
    await updateTask(TEAM_ID, "task_up1", {
      name: "new-name",
      url: "http://new-url",
      method: "PUT",
      enabled: false,
    });

    expect(mockTaskUpdate).toHaveBeenCalledTimes(1);
    const calls = mockTaskUpdate.mock.calls as any[][];
    const updateArg = calls[0][1];
    expect(updateArg.name).toBe("new-name");
    expect(updateArg.url).toBe("http://new-url");
    expect(updateArg.method).toBe("PUT");
    expect(updateArg.enabled).toBe(false);
    expect(updateArg.updatedAt).toBeInstanceOf(Date);
  });
});
