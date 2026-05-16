import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { scheduledTask, taskExecutionLog, user } from "../db/schema";

mock.module("../auth/better-auth", () => ({
  auth: {
    api: {
      getSession: async () => ({
        user: { id: "test_user", email: "task-routes@test.com", name: "Test" },
        session: { id: "sess_test", userId: "test_user", token: "tok" },
      }),
      signUpEmail: async () => ({}),
    },
  },
}));

const mockScheduleTask = mock(() => {});
const mockUnscheduleTask = mock(() => {});
const mockRescheduleTask = mock(() => {});

mock.module("../services/scheduler", () => ({
  scheduleTask: mockScheduleTask,
  unscheduleTask: mockUnscheduleTask,
  rescheduleTask: mockRescheduleTask,
  startScheduler: mock(() => Promise.resolve()),
  stopScheduler: mock(() => {}),
}));

const TEST_USER_ID = "test_user";

async function ensureUser() {
  const existing = await db.select().from(user).where(eq(user.id, TEST_USER_ID)).limit(1);
  if (existing.length > 0) return;
  const now = new Date();
  await db.insert(user).values({
    id: TEST_USER_ID,
    name: "Test",
    email: "task-routes@test.com",
    emailVerified: false,
    createdAt: now,
    updatedAt: now,
  });
}

async function cleanup() {
  try { await db.delete(taskExecutionLog); } catch {}
  try { await db.delete(scheduledTask).where(eq(scheduledTask.userId, TEST_USER_ID)); } catch {}
}

await ensureUser();

const app = (await import("../routes/web/tasks")).default;

mock.restore();

async function fetchRoute(path: string, options: RequestInit = {}) {
  return app.fetch(new Request(`http://localhost${path}`, options));
}

async function createTaskViaRoute(overrides: Record<string, unknown> = {}) {
  const res = await fetchRoute("/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Route Test",
      cron: "*/5 * * * *",
      timezone: "",
      url: "https://httpbin.org/post",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"hello":"world"}',
      ...overrides,
    }),
  });
  const body: any = await res.json();
  return body.data?.id as string | undefined;
}

describe("Task Routes", () => {
  beforeEach(async () => {
    await cleanup();
    mockScheduleTask.mockClear();
    mockUnscheduleTask.mockClear();
    mockRescheduleTask.mockClear();
  });

  afterEach(async () => {
    await cleanup();
  });

  describe("POST /web/tasks", () => {
    it("创建 HTTP cron 任务并调度", async () => {
      const res = await fetchRoute("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test",
          cron: "*/5 * * * *",
          timezone: "",
          url: "https://httpbin.org/post",
          method: "POST",
        }),
      });

      expect(res.status).toBe(201);
      const body: any = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.url).toBe("https://httpbin.org/post");
      expect(body.data.method).toBe("POST");
      expect(mockScheduleTask).toHaveBeenCalled();
    });

    it("验证失败返回 400", async () => {
      const res = await fetchRoute("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Test", cron: "bad", url: "https://example.com" }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("PUT /web/tasks/:id", () => {
    it("更新 url 和 enabled 字段后重新调度", async () => {
      const id = await createTaskViaRoute();
      expect(id).toBeTruthy();

      const res = await fetchRoute(`/tasks/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/updated", enabled: false }),
      });

      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.data.url).toBe("https://example.com/updated");
      expect(body.data.enabled).toBe(false);
      expect(mockRescheduleTask).toHaveBeenCalled();
    });
  });

  describe("GET /web/tasks/:id/logs", () => {
    it("返回执行日志列表", async () => {
      const id = await createTaskViaRoute();
      expect(id).toBeTruthy();

      const res = await fetchRoute(`/tasks/${id}/logs`);
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.success).toBe(true);
    });
  });
});
