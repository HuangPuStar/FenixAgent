import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { scheduledTask, taskExecutionLog, user } from "../db/schema";

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
} = await import("../services/task");

const USER_A = "user_task_a";
const USER_B = "user_task_b";

async function ensureUser(id: string, name: string, email: string) {
  const existing = await db.select().from(user).where(eq(user.id, id)).limit(1);
  if (existing.length > 0) return;
  const now = new Date();
  await db.insert(user).values({
    id,
    name,
    email,
    emailVerified: false,
    createdAt: now,
    updatedAt: now,
  });
}

async function cleanupTasks() {
  try { await db.delete(taskExecutionLog); } catch {}
  try { await db.delete(scheduledTask).where(eq(scheduledTask.userId, USER_A)); } catch {}
  try { await db.delete(scheduledTask).where(eq(scheduledTask.userId, USER_B)); } catch {}
}

await ensureUser(USER_A, "Alice Task", "alice-task@test.com");
await ensureUser(USER_B, "Bob Task", "bob-task@test.com");

beforeEach(async () => {
  await cleanupTasks();
});

afterEach(async () => {
  await cleanupTasks();
});

afterAll(async () => {
  try { await db.delete(taskExecutionLog); } catch {}
  try { await db.delete(scheduledTask); } catch {}
  try { await db.delete(user).where(eq(user.id, USER_A)); } catch {}
  try { await db.delete(user).where(eq(user.id, USER_B)); } catch {}
});

function getValidInput(overrides: Record<string, unknown> = {}) {
  return {
    name: "Test Task",
    cron: "*/5 * * * *",
    timezone: "",
    url: "https://httpbin.org/post",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"hello":"world"}',
    ...overrides,
  };
}

describe("Task Service", () => {
  describe("createTask", () => {
    it("创建 HTTP cron 任务并规范化空 timezone", async () => {
      const result = await createTask(USER_A, getValidInput());
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.id).toMatch(/^task_/);
      expect(result.data.url).toBe("https://httpbin.org/post");
      expect(result.data.method).toBe("POST");
      expect(result.data.timezone).toBeNull();
    });

    it("拒绝无效的 cron 表达式", async () => {
      const result = await createTask(USER_A, getValidInput({ cron: "abc" }));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
      }
    });

    it("拒绝空的 URL", async () => {
      const result = await createTask(USER_A, getValidInput({ url: "" }));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
      }
    });
  });

  describe("listTasks/getTask/updateTask", () => {
    it("列出用户的所有任务", async () => {
      await createTask(USER_A, getValidInput({ name: "Task A1" }));
      await createTask(USER_A, getValidInput({ name: "Task A2", url: "https://example.com/b" }));
      await createTask(USER_B, getValidInput({ name: "Task B1", url: "https://example.com/c" }));

      const result = await listTasks(USER_A);
      expect(result.success).toBe(true);
      expect(result.data.length).toBe(2);
    });

    it("通过 ID 获取任务详情", async () => {
      const created = await createTask(USER_A, getValidInput());
      if (!created.success) return;

      const result = await getTask(USER_A, created.data.id);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.url).toBe("https://httpbin.org/post");
      expect(result.data.method).toBe("POST");
    });

    it("更新 url 和 enabled 字段", async () => {
      const created = await createTask(USER_A, getValidInput());
      if (!created.success) return;

      const result = await updateTask(USER_A, created.data.id, {
        enabled: false,
        url: "https://example.com/updated",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.enabled).toBe(false);
      expect(result.data.url).toBe("https://example.com/updated");
    });
  });

  describe("deleteTask/toggleTask", () => {
    it("删除任务", async () => {
      const created = await createTask(USER_A, getValidInput());
      if (!created.success) return;
      const result = await deleteTask(USER_A, created.data.id);
      expect(result.success).toBe(true);

      const task = await getTask(USER_A, created.data.id);
      expect(task.success).toBe(false);
    });

    it("切换 enabled 状态", async () => {
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
    it("createExecutionLog 和 listExecutionLogs 记录执行日志", async () => {
      const created = await createTask(USER_A, getValidInput());
      if (!created.success) return;

      await createExecutionLog({
        taskId: created.data.id,
        status: "skipped",
        triggeredBy: "cron",
        skipReason: "previous_run_still_active",
        resultSummary: "skip summary",
      });

      const logs = await listExecutionLogs(created.data.id);
      expect(logs.success).toBe(true);
      expect(logs.data.total).toBe(1);
      expect(logs.data.items[0].skipReason).toBe("previous_run_still_active");
      expect(logs.data.items[0].resultSummary).toBe("skip summary");
    });
  });

  describe("clearExecutionLogs/getTaskById", () => {
    it("清除任务的所有执行日志", async () => {
      const created = await createTask(USER_A, getValidInput());
      if (!created.success) return;

      await createExecutionLog({ taskId: created.data.id, status: "success", resultSummary: "one" });
      await createExecutionLog({ taskId: created.data.id, status: "failed", resultSummary: "two" });

      await clearExecutionLogs(created.data.id);

      const logs = await listExecutionLogs(created.data.id);
      expect(logs.data.total).toBe(0);
    });

    it("通过 ID 获取任务（无权限过滤）", async () => {
      const created = await createTask(USER_A, getValidInput());
      if (!created.success) return;

      const task = await getTaskById(created.data.id);
      expect(task).toBeTruthy();
      expect(task?.id).toBe(created.data.id);
      expect(task?.url).toBe("https://httpbin.org/post");
    });
  });
});
