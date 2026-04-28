import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { environment, scheduledTask, taskExecutionLog, user } from "../db/schema";

const mockCancel = mock(() => {});
const mockNextInvocation = mock(() => ({ toJSDate: mock(() => new Date(Date.now() + 60000)) }));
const mockScheduleJob = mock((_config: unknown, handler: () => void) => ({
  cancel: mockCancel,
  nextInvocation: mockNextInvocation,
  __handler: handler,
}));
const mockRunAgentTask = mock();

mock.module("node-schedule", () => ({
  default: { scheduleJob: mockScheduleJob },
}));

mock.module("../logger", () => ({
  log: mock(() => {}),
  error: mock(() => {}),
}));

const scheduler = await import("../services/scheduler");
const { setRunAgentTaskForTesting } = await import("../services/task");

mock.restore();

const TEST_USER_ID = "user_scheduler_test";
const TEST_ENV_ID = "env_scheduler_test";

function ensureUser() {
  const existing = db.select().from(user).where(eq(user.id, TEST_USER_ID)).limit(1).all();
  if (existing.length > 0) return;
  const now = new Date();
  db.insert(user).values({
    id: TEST_USER_ID,
    name: "Scheduler Test",
    email: "scheduler-test@rcs.local",
    emailVerified: false,
    createdAt: now,
    updatedAt: now,
  }).run();
}

function ensureEnvironment() {
  const existing = db.select().from(environment).where(eq(environment.id, TEST_ENV_ID)).limit(1).all();
  if (existing.length > 0) return;
  const now = new Date();
  db.insert(environment).values({
    id: TEST_ENV_ID,
    name: "scheduler-env",
    description: null,
    workspacePath: "/tmp/scheduler-env",
    agentName: "scheduler-agent",
    status: "idle",
    machineName: null,
    branch: null,
    gitRepoUrl: null,
    maxSessions: 1,
    workerType: "acp",
    capabilities: null,
    secret: "scheduler-secret",
    userId: TEST_USER_ID,
    lastPollAt: null,
    createdAt: now,
    updatedAt: now,
  }).run();
}

function insertTask(id: string, enabled: boolean, timezone: string | null, cron = "* * * * *") {
  const now = new Date();
  try {
    db.insert(scheduledTask).values({
      id,
      userId: TEST_USER_ID,
      name: id,
      description: null,
      cron,
      timezone,
      enabled,
      environmentId: TEST_ENV_ID,
      task: "echo hi",
      timeoutMinutes: 30,
      lastRunAt: null,
      nextRunAt: null,
      lastStatus: null,
      createdAt: now,
      updatedAt: now,
    }).run();
  } catch {}
}

function cleanupRows() {
  try { db.delete(taskExecutionLog).run(); } catch {}
  try { db.delete(scheduledTask).where(eq(scheduledTask.userId, TEST_USER_ID)).run(); } catch {}
}

ensureUser();
ensureEnvironment();

describe("Scheduler", () => {
  beforeEach(() => {
    scheduler.stopScheduler();
    cleanupRows();
    mockScheduleJob.mockClear();
    mockCancel.mockClear();
    mockRunAgentTask.mockReset();
    setRunAgentTaskForTesting(mockRunAgentTask);
  });

  afterAll(() => {
    scheduler.stopScheduler();
    cleanupRows();
    setRunAgentTaskForTesting(null);
    try { db.delete(environment).where(eq(environment.id, TEST_ENV_ID)).run(); } catch {}
    try { db.delete(user).where(eq(user.id, TEST_USER_ID)).run(); } catch {}
  });

  describe("scheduleTask", () => {
    it("registers a cron job for enabled task", () => {
      scheduler.scheduleTask({ id: "task_abc", cron: "*/5 * * * *", timezone: "UTC", enabled: true });
      expect(mockScheduleJob).toHaveBeenCalled();
    });

    it("omits tz when timezone is null", () => {
      scheduler.scheduleTask({ id: "task_local", cron: "*/5 * * * *", timezone: null, enabled: true });
      expect(mockScheduleJob).toHaveBeenCalledWith({ rule: "*/5 * * * *" }, expect.any(Function));
    });

    it("skips disabled task", () => {
      const before = mockScheduleJob.mock.calls.length;
      scheduler.scheduleTask({ id: "task_disabled", cron: "*/5 * * * *", timezone: "UTC", enabled: false });
      expect(mockScheduleJob.mock.calls.length).toBe(before);
    });
  });

  describe("startScheduler", () => {
    it("schedules only enabled tasks from db", async () => {
      insertTask("task_s1", true, "UTC", "1 * * * *");
      insertTask("task_s2", false, "UTC", "2 * * * *");

      await scheduler.startScheduler();

      const scheduledRules = mockScheduleJob.mock.calls.map(([config]) => (config as { rule: string }).rule);
      expect(scheduledRules).toContain("1 * * * *");
      expect(scheduledRules).not.toContain("2 * * * *");
    });
  });

  describe("concurrent execution", () => {
    it("writes skipped log when the same task triggers twice", async () => {
      insertTask("task_skip", true, "UTC");

      let resolveExecution: (() => void) | null = null;
      mockRunAgentTask.mockImplementation(() => new Promise((resolve) => {
        resolveExecution = () => resolve({
          status: "success",
          workspacePath: "/tmp/scheduler-env/.scheduled-runs/task_skip/log_1",
          workspaceName: "20260427-130000-log_1",
          resultSummary: "done",
          error: null,
          duration: 123,
        });
      }));

      scheduler.scheduleTask({ id: "task_skip", cron: "* * * * *", timezone: "UTC", enabled: true });
      const handler = (mockScheduleJob.mock.results.at(-1)?.value as { __handler: () => void }).__handler;

      handler();
      await new Promise((resolve) => setTimeout(resolve, 0));
      handler();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const logs = db.select().from(taskExecutionLog).where(eq(taskExecutionLog.taskId, "task_skip")).all();
      expect(logs.some((row) => row.status === "skipped" && row.skipReason === "previous_run_still_active")).toBe(true);

      expect(resolveExecution).toBeDefined();
      resolveExecution!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });
});
