// ── clearExecutionLogs 所有权校验 ──
import { describe, test, expect, mock, beforeEach } from "bun:test";

const TEAM_ID = "aaaaaaaa-0000-0000-0000-000000000001";

mock.module("../repositories/task", () => ({
  scheduledTaskRepo: {
    getByTeamAndId: mock(async () => null),
    deleteByTeamAndId: mock(async () => false),
  },
  taskExecutionLogRepo: {
    deleteByTask: mock(async () => {}),
  },
}));
mock.module("../services/config/jsonb", () => ({
  parseJsonb: mock((v: unknown) => v),
}));
mock.module("../logger", () => ({
  log: mock(),
  error: mock(),
}));
mock.module("./scheduler", () => ({
  scheduleTask: mock(() => true),
  rescheduleTask: mock(() => true),
  unscheduleTask: mock(),
}));

const { clearExecutionLogs } = await import("../services/task");

const { scheduledTaskRepo, taskExecutionLogRepo } = await import("../repositories/task");

describe("clearExecutionLogs ownership verification", () => {
  beforeEach(() => {
    (scheduledTaskRepo.getByTeamAndId as ReturnType<typeof mock>).mockReset();
    (taskExecutionLogRepo.deleteByTask as ReturnType<typeof mock>).mockReset();
  });

  // 任务不属于该团队时返回 NOT_FOUND
  test("returns NOT_FOUND when task does not belong to team", async () => {
    (scheduledTaskRepo.getByTeamAndId as ReturnType<typeof mock>)
      .mockResolvedValueOnce(null);

    const result = await clearExecutionLogs(TEAM_ID, "task-1");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
    expect(taskExecutionLogRepo.deleteByTask).not.toHaveBeenCalled();
  });

  // 任务属于该团队时清除日志成功
  test("deletes logs when task belongs to team", async () => {
    (scheduledTaskRepo.getByTeamAndId as ReturnType<typeof mock>)
      .mockResolvedValueOnce({ id: "task-1", teamId: TEAM_ID });

    const result = await clearExecutionLogs(TEAM_ID, "task-1");
    expect(result.success).toBe(true);
    expect(taskExecutionLogRepo.deleteByTask).toHaveBeenCalledWith("task-1");
  });

  // 其他团队的任务不会触发 delete
  test("does not delete logs for other team's task", async () => {
    (scheduledTaskRepo.getByTeamAndId as ReturnType<typeof mock>)
      .mockResolvedValueOnce(null);

    const wrongTeamId = "bbbbbbbb-0000-0000-0000-000000000001";
    await clearExecutionLogs(wrongTeamId, "task-1");
    expect(taskExecutionLogRepo.deleteByTask).not.toHaveBeenCalled();
  });
});
