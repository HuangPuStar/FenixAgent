import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { environment, scheduledTask, taskExecutionLog, user } from "../db/schema";

const mockRunAgentTask = mock();

const {
  createTask,
  listTasks,
  getTask,
  updateTask,
  deleteTask,
  toggleTask,
  triggerTask,
  listExecutionLogs,
  clearExecutionLogs,
  getTaskById,
  createExecutionLog,
  executeTaskById,
  setRunAgentTaskForTesting,
} = await import("../services/task");

const USER_A = "user_task_a";
const USER_B = "user_task_b";
const ENV_A = "env_task_a";
const ENV_B = "env_task_b";

function ensureUser(id: string, name: string, email: string) {
  const existing = db.select().from(user).where(eq(user.id, id)).limit(1).all();
  if (existing.length > 0) return;
  const now = new Date();
  db.insert(user).values({
    id,
    name,
    email,
    emailVerified: false,
    createdAt: now,
    updatedAt: now,
  }).run();
}

function ensureEnvironment(id: string, userId: string, name: string, workspacePath: string) {
  const existing = db.select().from(environment).where(eq(environment.id, id)).limit(1).all();
  if (existing.length > 0) return;
  const now = new Date();
  db.insert(environment).values({
    id,
    name,
    description: null,
    workspacePath,
    agentName: `${name}-agent`,
    status: "idle",
    machineName: null,
    branch: null,
    gitRepoUrl: null,
    maxSessions: 1,
    workerType: "acp",
    capabilities: null,
    secret: `${id}-secret`,
    userId,
    lastPollAt: null,
    createdAt: now,
    updatedAt: now,
  }).run();
}

function cleanupTasks() {
  try { db.delete(taskExecutionLog).run(); } catch {}
  try { db.delete(scheduledTask).where(eq(scheduledTask.userId, USER_A)).run(); } catch {}
  try { db.delete(scheduledTask).where(eq(scheduledTask.userId, USER_B)).run(); } catch {}
}

ensureUser(USER_A, "Alice Task", "alice-task@test.com");
ensureUser(USER_B, "Bob Task", "bob-task@test.com");
ensureEnvironment(ENV_A, USER_A, "env-a", "/tmp/env-a");
ensureEnvironment(ENV_B, USER_B, "env-b", "/tmp/env-b");

beforeEach(() => {
  cleanupTasks();
  mockRunAgentTask.mockReset();
  setRunAgentTaskForTesting(mockRunAgentTask);
});

afterEach(() => {
  cleanupTasks();
  setRunAgentTaskForTesting(null);
});

afterAll(() => {
  setRunAgentTaskForTesting(null);
  try { db.delete(taskExecutionLog).run(); } catch {}
  try { db.delete(scheduledTask).run(); } catch {}
  try { db.delete(environment).where(and(eq(environment.id, ENV_A), eq(environment.userId, USER_A))).run(); } catch {}
  try { db.delete(environment).where(and(eq(environment.id, ENV_B), eq(environment.userId, USER_B))).run(); } catch {}
  try { db.delete(user).where(eq(user.id, USER_A)).run(); } catch {}
  try { db.delete(user).where(eq(user.id, USER_B)).run(); } catch {}
});

function getValidInput(overrides: Record<string, unknown> = {}) {
  return {
    name: "Test Task",
    cron: "*/5 * * * *",
    timezone: "",
    environmentId: ENV_A,
    task: "echo hello",
    timeoutMinutes: 30,
    ...overrides,
  };
}

describe("Task Service", () => {
  describe("createTask", () => {
    it("creates an agent task and normalizes empty timezone", async () => {
      const result = await createTask(USER_A, getValidInput());
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.id).toMatch(/^task_/);
      expect(result.data.environmentId).toBe(ENV_A);
      expect(result.data.environmentName).toBe("env-a");
      expect(result.data.task).toBe("echo hello");
      expect(result.data.timeoutMinutes).toBe(30);
      expect(result.data.timezone).toBeNull();
    });

    it("rejects invalid cron expression", async () => {
      const result = await createTask(USER_A, getValidInput({ cron: "abc" }));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
      }
    });

    it("rejects non-owned environment", async () => {
      const result = await createTask(USER_A, getValidInput({ environmentId: ENV_B }));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
      }
    });
  });

  describe("listTasks/getTask/updateTask", () => {
    it("lists tasks with environment names", async () => {
      await createTask(USER_A, getValidInput({ name: "Task A1" }));
      await createTask(USER_A, getValidInput({ name: "Task A2", task: "echo world" }));
      await createTask(USER_B, getValidInput({ name: "Task B1", environmentId: ENV_B, task: "echo bob" }));

      const result = await listTasks(USER_A);
      expect(result.success).toBe(true);
      expect(result.data.length).toBe(2);
      expect(result.data.every((task) => task.environmentName === "env-a")).toBe(true);
    });

    it("returns task detail by id", async () => {
      const created = await createTask(USER_A, getValidInput());
      if (!created.success) return;

      const result = await getTask(USER_A, created.data.id);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.environmentName).toBe("env-a");
      expect(result.data.task).toBe("echo hello");
    });

    it("updates timeoutMinutes and enabled fields", async () => {
      const created = await createTask(USER_A, getValidInput());
      if (!created.success) return;

      const result = await updateTask(USER_A, created.data.id, {
        timeoutMinutes: 45,
        enabled: false,
        task: "echo updated",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.timeoutMinutes).toBe(45);
      expect(result.data.enabled).toBe(false);
      expect(result.data.task).toBe("echo updated");
    });

    it("rejects update when environment is not owned", async () => {
      const created = await createTask(USER_A, getValidInput());
      if (!created.success) return;

      const result = await updateTask(USER_A, created.data.id, { environmentId: ENV_B });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
      }
    });
  });

  describe("deleteTask/toggleTask", () => {
    it("deletes a task", async () => {
      const created = await createTask(USER_A, getValidInput());
      if (!created.success) return;
      const result = await deleteTask(USER_A, created.data.id);
      expect(result.success).toBe(true);

      const task = await getTask(USER_A, created.data.id);
      expect(task.success).toBe(false);
    });

    it("toggles enabled state", async () => {
      const created = await createTask(USER_A, getValidInput());
      if (!created.success) return;

      const disabled = await toggleTask(USER_A, created.data.id);
      expect(disabled.success).toBe(true);
      if (disabled.success) {
        expect(disabled.data.enabled).toBe(false);
      }

      const enabled = await toggleTask(USER_A, created.data.id);
      expect(enabled.success).toBe(true);
      if (enabled.success) {
        expect(enabled.data.enabled).toBe(true);
      }
    });
  });

  describe("execution flow", () => {
    it("triggerTask writes workspace and summary fields on success", async () => {
      const created = await createTask(USER_A, getValidInput());
      if (!created.success) return;

      mockRunAgentTask.mockResolvedValue({
        status: "success",
        workspacePath: "/tmp/env-a/.scheduled-runs/task-1/log-1",
        workspaceName: "20260427-120000-log-1",
        resultSummary: "run summary",
        error: null,
        duration: 321,
      });

      const result = await triggerTask(USER_A, created.data.id);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.status).toBe("success");
      expect(result.data.workspacePath).toContain(".scheduled-runs");
      expect(result.data.resultSummary).toBe("run summary");
      expect(result.data.environmentId).toBe(ENV_A);
      expect(result.data.environmentName).toBe("env-a");

      const task = await getTaskById(created.data.id);
      expect(task?.lastStatus).toBe("success");
    });

    it("executeTaskById maps timeout status from runner", async () => {
      const created = await createTask(USER_A, getValidInput());
      if (!created.success) return;

      mockRunAgentTask.mockResolvedValue({
        status: "timeout",
        workspacePath: "/tmp/env-a/.scheduled-runs/task-2/log-2",
        workspaceName: "20260427-120500-log-2",
        resultSummary: "timeout summary",
        error: "Task execution timed out",
        duration: 1800000,
      });

      const result = await executeTaskById(created.data.id, "manual");
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.status).toBe("timeout");
      expect(result.data.error).toBe("Task execution timed out");
      expect(result.data.resultSummary).toBe("timeout summary");
    });

    it("createExecutionLog and listExecutionLogs expose workspace metadata", async () => {
      const created = await createTask(USER_A, getValidInput());
      if (!created.success) return;

      await createExecutionLog({
        taskId: created.data.id,
        status: "skipped",
        triggeredBy: "cron",
        workspacePath: "/tmp/env-a/.scheduled-runs/task/log",
        workspaceName: "task-log",
        environmentId: ENV_A,
        environmentName: "env-a",
        taskSnapshot: "echo hello",
        skipReason: "previous_run_still_active",
        resultSummary: "skip summary",
      });

      const logs = await listExecutionLogs(created.data.id);
      expect(logs.success).toBe(true);
      expect(logs.data.total).toBe(1);
      expect(logs.data.items[0].workspacePath).toContain(".scheduled-runs");
      expect(logs.data.items[0].skipReason).toBe("previous_run_still_active");
      expect(logs.data.items[0].resultSummary).toBe("skip summary");
    });
  });

  describe("clearExecutionLogs/getTaskById", () => {
    it("clears all logs for a task", async () => {
      const created = await createTask(USER_A, getValidInput());
      if (!created.success) return;

      await createExecutionLog({ taskId: created.data.id, status: "success", resultSummary: "one" });
      await createExecutionLog({ taskId: created.data.id, status: "failed", resultSummary: "two" });

      await clearExecutionLogs(created.data.id);

      const logs = await listExecutionLogs(created.data.id);
      expect(logs.data.total).toBe(0);
    });

    it("returns task by id without ownership filter", async () => {
      const created = await createTask(USER_A, getValidInput());
      if (!created.success) return;

      const task = await getTaskById(created.data.id);
      expect(task).toBeTruthy();
      expect(task?.id).toBe(created.data.id);
      expect(task?.environmentId).toBe(ENV_A);
    });
  });
});
