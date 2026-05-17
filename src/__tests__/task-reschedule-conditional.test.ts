// 测试 updateTask 仅在调度相关字段变更时重新调度；toggleTask 验证更新结果
import { describe, test, expect, mock, beforeEach } from "bun:test";

const TEAM_ID = "aaaaaaaa-0000-0000-0000-000000000001";

// mock 依赖
const mockCreate = mock(async (data: any) => ({ ...data, lastRunAt: null, nextRunAt: null, lastStatus: null }));
const mockGetByTeamAndId = mock(async () => null) as any;
const mockUpdate = mock(async () => null) as any;

mock.module("../repositories/task", () => ({
  scheduledTaskRepo: {
    listByTeam: mock(async () => []),
    getById: mock(async () => null),
    getByTeamAndId: mockGetByTeamAndId,
    create: mockCreate,
    update: mockUpdate,
    deleteByTeamAndId: mock(async () => true),
    listEnabled: mock(async () => []),
  },
  taskExecutionLogRepo: {
    listByTaskPaged: mock(async () => ({ rows: [], total: 0 })),
    create: mock(async (d: any) => d),
  },
}));

let rescheduleCalled = false;
let rescheduleArg: any = null;

mock.module("../services/scheduler", () => ({
  scheduleTask: mock(() => true),
  rescheduleTask: mock((arg: any) => { rescheduleCalled = true; rescheduleArg = arg; }),
  unscheduleTask: mock(() => {}),
}));

mock.module("../services/config/jsonb", () => ({
  parseJsonb: (v: any) => v,
}));

const { updateTask, toggleTask } = await import("../services/task");

describe("updateTask conditional reschedule", () => {
  const baseTask = {
    id: "t1",
    userId: "u1",
    teamId: TEAM_ID,
    name: "test",
    description: null,
    cron: "0 * * * *",
    timezone: null,
    enabled: true,
    url: "http://example.com",
    method: "POST",
    headers: null,
    body: null,
    lastRunAt: null,
    nextRunAt: null,
    lastStatus: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    rescheduleCalled = false;
    rescheduleArg = null;
    mockGetByTeamAndId.mockImplementation(async () => ({ ...baseTask }));
    mockUpdate.mockImplementation(async (_id: string, data: any) => ({ ...baseTask, ...data }));
  });

  test("reschedules when cron changes", async () => {
    const result = await updateTask(TEAM_ID, "t1", { cron: "*/5 * * * *" });
    expect(result.success).toBe(true);
    expect(rescheduleCalled).toBe(true);
  });

  test("reschedules when enabled changes", async () => {
    const result = await updateTask(TEAM_ID, "t1", { enabled: false });
    expect(result.success).toBe(true);
    expect(rescheduleCalled).toBe(true);
  });

  test("does not reschedule when only name changes", async () => {
    const result = await updateTask(TEAM_ID, "t1", { name: "new-name" });
    expect(result.success).toBe(true);
    expect(rescheduleCalled).toBe(false);
  });

  test("does not reschedule when only description changes", async () => {
    const result = await updateTask(TEAM_ID, "t1", { description: "new desc" });
    expect(result.success).toBe(true);
    expect(rescheduleCalled).toBe(false);
  });

  test("does not reschedule when only url changes", async () => {
    const result = await updateTask(TEAM_ID, "t1", { url: "http://new.example.com" });
    expect(result.success).toBe(true);
    expect(rescheduleCalled).toBe(false);
  });

  test("reschedules when timezone changes", async () => {
    const result = await updateTask(TEAM_ID, "t1", { timezone: "Asia/Tokyo" });
    expect(result.success).toBe(true);
    expect(rescheduleCalled).toBe(true);
  });
});

describe("toggleTask update verification", () => {
  const baseTask = {
    id: "t1",
    userId: "u1",
    teamId: TEAM_ID,
    name: "test",
    description: null,
    cron: "0 * * * *",
    timezone: null,
    enabled: true,
    url: "http://example.com",
    method: "POST",
    headers: null,
    body: null,
    lastRunAt: null,
    nextRunAt: null,
    lastStatus: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  test("returns NOT_FOUND when update returns null (concurrent delete)", async () => {
    mockGetByTeamAndId.mockImplementation(async () => ({ ...baseTask }));
    mockUpdate.mockImplementation(async () => null);

    const result = await toggleTask(TEAM_ID, "t1");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("returns success when update succeeds", async () => {
    mockGetByTeamAndId.mockImplementation(async () => ({ ...baseTask }));
    mockUpdate.mockImplementation(async (_id: string, data: any) => ({ ...baseTask, ...data }));

    const result = await toggleTask(TEAM_ID, "t1");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(false);
    }
  });
});
