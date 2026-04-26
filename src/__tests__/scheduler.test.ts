import { describe, it, expect, mock } from "bun:test";

// Mock node-schedule
const mockCancel = mock(() => {});
const mockNextInvocation = mock(() => ({ toJSDate: mock(() => new Date(Date.now() + 60000)) }));
const mockScheduleJob = mock(() => ({
  cancel: mockCancel,
  nextInvocation: mockNextInvocation,
}));

mock.module("node-schedule", () => ({
  default: { scheduleJob: mockScheduleJob },
}));

// Mock db with proper chaining
const mockUpdateWhere = mock(() => ({
  then: mock((cb: any) => { cb(); return { catch: mock(() => {}) }; }),
  catch: mock(() => {}),
}));
const mockUpdateSet = mock(() => ({ where: mockUpdateWhere }));
const mockDbUpdate = mock(() => ({ set: mockUpdateSet }));

const mockWhere = mock(() => Promise.resolve([]));
const mockFrom = mock(() => ({ where: mockWhere }));
const mockSelect = mock(() => ({ from: mockFrom }));

mock.module("../db", () => ({
  db: { select: mockSelect, update: mockDbUpdate },
}));

// Mock task service
mock.module("../services/task", () => ({
  getTaskById: mock(() => Promise.resolve(null)),
  createExecutionLog: mock(() => Promise.resolve("log_xxx")),
}));

// Mock logger
mock.module("../logger", () => ({
  log: mock(() => {}),
  error: mock(() => {}),
}));

// Dynamic import for fresh module
const scheduler = await import("../services/scheduler");

describe("Scheduler", () => {
  const enabledTask = {
    id: "task_abc",
    cron: "*/5 * * * *",
    timezone: "UTC",
    enabled: true,
  };

  const disabledTask = {
    id: "task_def",
    cron: "*/5 * * * *",
    timezone: "UTC",
    enabled: false,
  };

  // Cleanup between tests
  const cleanup = () => scheduler.stopScheduler();

  describe("scheduleTask", () => {
    it("should register a cron job for enabled task", () => {
      cleanup();
      scheduler.scheduleTask(enabledTask);
      expect(mockScheduleJob).toHaveBeenCalled();
      cleanup();
    });

    it("should skip disabled task", () => {
      cleanup();
      const before = mockScheduleJob.mock.calls.length;
      scheduler.scheduleTask(disabledTask);
      expect(mockScheduleJob.mock.calls.length).toBe(before);
      cleanup();
    });

    it("should be idempotent — re-scheduling same task replaces old job", () => {
      cleanup();
      scheduler.scheduleTask(enabledTask);
      const count1 = mockScheduleJob.mock.calls.length;
      scheduler.scheduleTask(enabledTask);
      expect(mockScheduleJob.mock.calls.length).toBeGreaterThan(count1);
      cleanup();
    });
  });

  describe("unscheduleTask", () => {
    it("should cancel a scheduled task without error", () => {
      cleanup();
      scheduler.scheduleTask(enabledTask);
      scheduler.unscheduleTask(enabledTask.id);
      expect(mockCancel).toHaveBeenCalled();
      cleanup();
    });

    it("should handle non-existent task gracefully", () => {
      cleanup();
      expect(() => scheduler.unscheduleTask("task_nonexistent")).not.toThrow();
      cleanup();
    });
  });

  describe("rescheduleTask", () => {
    it("should call scheduleJob with updated cron", () => {
      cleanup();
      scheduler.scheduleTask(enabledTask);
      mockScheduleJob.mock.calls.length = 0;
      scheduler.rescheduleTask({ ...enabledTask, cron: "0 * * * *" });
      expect(mockScheduleJob.mock.calls.length).toBe(1);
      cleanup();
    });
  });

  describe("startScheduler", () => {
    it("should schedule all enabled tasks from db", async () => {
      cleanup();
      mockSelect.mockImplementationOnce(() => ({
        from: mock(() => ({
          where: mock(() => Promise.resolve([
            { id: "task_1", cron: "* * * * *", enabled: true, timezone: "UTC" },
            { id: "task_2", cron: "*/10 * * * *", enabled: true, timezone: "UTC" },
            { id: "task_3", cron: "0 * * * *", enabled: true, timezone: "UTC" },
          ])),
        })),
      }));

      await scheduler.startScheduler();
      expect(mockScheduleJob.mock.calls.length).toBeGreaterThanOrEqual(3);
      cleanup();
    });

    it("should handle no tasks without error", async () => {
      cleanup();
      mockSelect.mockImplementationOnce(() => ({
        from: mock(() => ({
          where: mock(() => Promise.resolve([])),
        })),
      }));

      await scheduler.startScheduler();
      expect(true).toBe(true); // No error = pass
      cleanup();
    });
  });

  describe("stopScheduler", () => {
    it("should stop without error even with active jobs", () => {
      cleanup();
      scheduler.scheduleTask(enabledTask);
      scheduler.scheduleTask({ ...enabledTask, id: "task_2" });
      expect(() => scheduler.stopScheduler()).not.toThrow();
      cleanup();
    });
  });
});
