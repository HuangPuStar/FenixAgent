import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { scheduledTask, taskExecutionLog, team, teamMember, user } from "../db/schema";

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

// user.id 是 text 类型，但 team.id 是 uuid 类型
const USER_A = "user_task_a";
const USER_B = "user_task_b";
const TEAM_A = "aaaaaaaa-0000-0000-0000-000000000001";
const TEAM_B = "aaaaaaaa-0000-0000-0000-000000000002";

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

async function ensureTeam(id: string, name: string, slug: string, createdBy: string) {
  const existing = await db.select().from(team).where(eq(team.id, id)).limit(1);
  if (existing.length > 0) return;
  const now = new Date();
  await db.insert(team).values({
    id,
    name,
    slug,
    description: null,
    createdBy,
    createdAt: now,
    updatedAt: now,
  });
  // 同时创建 team_member 记录
  await db.insert(teamMember).values({
    teamId: id,
    userId: createdBy,
    role: "owner",
    joinedAt: now,
  }).onConflictDoNothing();
}

async function cleanupTasks() {
  try { await db.delete(taskExecutionLog); } catch {}
  try { await db.delete(scheduledTask).where(eq(scheduledTask.teamId, TEAM_A)); } catch {}
  try { await db.delete(scheduledTask).where(eq(scheduledTask.teamId, TEAM_B)); } catch {}
}

await ensureUser(USER_A, "Alice Task", "alice-task@test.com");
await ensureUser(USER_B, "Bob Task", "bob-task@test.com");
await ensureTeam(TEAM_A, "Team A", "team-a-task", USER_A);
await ensureTeam(TEAM_B, "Team B", "team-b-task", USER_B);

beforeEach(async () => {
  await cleanupTasks();
});

afterEach(async () => {
  await cleanupTasks();
});

afterAll(async () => {
  try { await db.delete(taskExecutionLog); } catch {}
  try { await db.delete(scheduledTask).where(eq(scheduledTask.teamId, TEAM_A)); } catch {}
  try { await db.delete(scheduledTask).where(eq(scheduledTask.teamId, TEAM_B)); } catch {}
  try { await db.delete(teamMember).where(eq(teamMember.teamId, TEAM_A)); } catch {}
  try { await db.delete(teamMember).where(eq(teamMember.teamId, TEAM_B)); } catch {}
  try { await db.delete(team).where(eq(team.id, TEAM_A)); } catch {}
  try { await db.delete(team).where(eq(team.id, TEAM_B)); } catch {}
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
      const result = await createTask(TEAM_A, getValidInput(), USER_A);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.data.url).toBe("https://httpbin.org/post");
      expect(result.data.method).toBe("POST");
      expect(result.data.timezone).toBeNull();
    });

    it("拒绝无效的 cron 表达式", async () => {
      const result = await createTask(TEAM_A, getValidInput({ cron: "abc" }), USER_A);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
      }
    });

    it("拒绝空的 URL", async () => {
      const result = await createTask(TEAM_A, getValidInput({ url: "" }), USER_A);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
      }
    });
  });

  describe("listTasks/getTask/updateTask", () => {
    it("列出团队的所有任务", async () => {
      await createTask(TEAM_A, getValidInput({ name: "Task A1" }), USER_A);
      await createTask(TEAM_A, getValidInput({ name: "Task A2", url: "https://example.com/b" }), USER_A);
      await createTask(TEAM_B, getValidInput({ name: "Task B1", url: "https://example.com/c" }), USER_B);

      const result = await listTasks(TEAM_A);
      expect(result.success).toBe(true);
      expect(result.data.length).toBe(2);
    });

    it("通过 ID 获取任务详情", async () => {
      const created = await createTask(TEAM_A, getValidInput(), USER_A);
      if (!created.success) return;

      const result = await getTask(TEAM_A, created.data.id);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.url).toBe("https://httpbin.org/post");
      expect(result.data.method).toBe("POST");
    });

    it("更新 url 和 enabled 字段", async () => {
      const created = await createTask(TEAM_A, getValidInput(), USER_A);
      if (!created.success) return;

      const result = await updateTask(TEAM_A, created.data.id, {
        enabled: false,
        url: "https://example.com/updated",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.enabled).toBe(false);
      expect(result.data.url).toBe("https://example.com/updated");
    });

    // 验证 headers 字段从 jsonb 正确解析为对象（非字符串）
    it("createTask 返回的 headers 为解析后的对象", async () => {
      const result = await createTask(TEAM_A, getValidInput({
        headers: { "X-Custom": "value", "Authorization": "Bearer abc" },
      }), USER_A);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(typeof result.data.headers).toBe("object");
      expect(result.data.headers).not.toBeNull();
      expect(result.data.headers!["X-Custom"]).toBe("value");
      expect(result.data.headers!["Authorization"]).toBe("Bearer abc");
    });

    // 验证 getTask 返回的 headers 也是解析后的对象
    it("getTask 返回的 headers 为解析后的对象", async () => {
      const created = await createTask(TEAM_A, getValidInput({
        headers: { "Content-Type": "application/xml" },
      }), USER_A);
      if (!created.success) return;

      const result = await getTask(TEAM_A, created.data.id);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(typeof result.data.headers).toBe("object");
      expect(result.data.headers).not.toBeNull();
      expect(result.data.headers!["Content-Type"]).toBe("application/xml");
    });

    // headers 为 null 时正确处理
    it("createTask 不传 headers 时返回 null", async () => {
      const result = await createTask(TEAM_A, getValidInput({ headers: undefined }), USER_A);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.headers).toBeNull();
    });
  });

  describe("deleteTask/toggleTask", () => {
    it("删除任务", async () => {
      const created = await createTask(TEAM_A, getValidInput(), USER_A);
      if (!created.success) return;
      const result = await deleteTask(TEAM_A, created.data.id);
      expect(result.success).toBe(true);

      const task = await getTask(TEAM_A, created.data.id);
      expect(task.success).toBe(false);
    });

    it("切换 enabled 状态", async () => {
      const created = await createTask(TEAM_A, getValidInput(), USER_A);
      if (!created.success) return;

      const disabled = await toggleTask(TEAM_A, created.data.id);
      expect(disabled.success).toBe(true);
      if (disabled.success) {
        expect(disabled.data.enabled).toBe(false);
      }

      const enabled = await toggleTask(TEAM_A, created.data.id);
      expect(enabled.success).toBe(true);
      if (enabled.success) {
        expect(enabled.data.enabled).toBe(true);
      }
    });
  });

  describe("execution flow", () => {
    it("createExecutionLog 和 listExecutionLogs 记录执行日志", async () => {
      const created = await createTask(TEAM_A, getValidInput(), USER_A);
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
      const created = await createTask(TEAM_A, getValidInput(), USER_A);
      if (!created.success) return;

      await createExecutionLog({ taskId: created.data.id, status: "success", resultSummary: "one" });
      await createExecutionLog({ taskId: created.data.id, status: "failed", resultSummary: "two" });

      await clearExecutionLogs(TEAM_A, created.data.id);

      const logs = await listExecutionLogs(created.data.id);
      expect(logs.data.total).toBe(0);
    });

    it("通过 ID 获取任务（无权限过滤）", async () => {
      const created = await createTask(TEAM_A, getValidInput(), USER_A);
      if (!created.success) return;

      const task = await getTaskById(created.data.id);
      expect(task).toBeTruthy();
      expect(task?.id).toBe(created.data.id);
      expect(task?.url).toBe("https://httpbin.org/post");
    });
  });
});
