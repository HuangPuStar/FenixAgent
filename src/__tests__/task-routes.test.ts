import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { environment, scheduledTask, taskExecutionLog, user } from "../db/schema";

const mockRunAgentTask = mock(() => Promise.resolve({
  status: "success",
  workspacePath: "/tmp/route-env/.scheduled-runs/task/log",
  workspaceName: "20260427-130000-log",
  resultSummary: "route summary",
  error: null,
  duration: 88,
}));

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
const TEST_ENV_ID = "env_routes_test";

function ensureUser() {
  const existing = db.select().from(user).where(eq(user.id, TEST_USER_ID)).limit(1).all();
  if (existing.length > 0) return;
  const now = new Date();
  db.insert(user).values({
    id: TEST_USER_ID,
    name: "Test",
    email: "task-routes@test.com",
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
    name: "route-env",
    description: null,
    workspacePath: "/tmp/route-env",
    agentName: "route-agent",
    status: "idle",
    machineName: null,
    branch: null,
    gitRepoUrl: null,
    maxSessions: 1,
    workerType: "acp",
    capabilities: null,
    secret: "route-secret",
    userId: TEST_USER_ID,
    lastPollAt: null,
    createdAt: now,
    updatedAt: now,
  }).run();
}

function cleanup() {
  try { db.delete(taskExecutionLog).run(); } catch {}
  try { db.delete(scheduledTask).where(eq(scheduledTask.userId, TEST_USER_ID)).run(); } catch {}
}

ensureUser();
ensureEnvironment();

const app = (await import("../routes/web/tasks")).default;
const { setRunAgentTaskForTesting } = await import("../services/task");

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
      environmentId: TEST_ENV_ID,
      task: "echo route",
      timeoutMinutes: 30,
      ...overrides,
    }),
  });
  const body: any = await res.json();
  return body.data?.id as string | undefined;
}

describe("Task Routes", () => {
  beforeEach(() => {
    cleanup();
    mockRunAgentTask.mockClear();
    mockScheduleTask.mockClear();
    mockUnscheduleTask.mockClear();
    mockRescheduleTask.mockClear();
    setRunAgentTaskForTesting(mockRunAgentTask);
  });

  afterEach(() => {
    cleanup();
    setRunAgentTaskForTesting(null);
  });

  describe("POST /web/tasks", () => {
    it("creates an agent task and schedules it", async () => {
      const res = await fetchRoute("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test",
          cron: "*/5 * * * *",
          timezone: "",
          environmentId: TEST_ENV_ID,
          task: "echo hello",
          timeoutMinutes: 30,
        }),
      });

      expect(res.status).toBe(201);
      const body: any = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.environmentId).toBe(TEST_ENV_ID);
      expect(body.data.task).toBe("echo hello");
      expect(body.data.timeoutMinutes).toBe(30);
      expect(mockScheduleTask).toHaveBeenCalled();
    });

    it("returns 400 on validation error", async () => {
      const res = await fetchRoute("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Test", cron: "bad", environmentId: TEST_ENV_ID, task: "echo hi" }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("PUT /web/tasks/:id", () => {
    it("updates timeoutMinutes and enabled fields, then reschedules", async () => {
      const id = await createTaskViaRoute();
      expect(id).toBeTruthy();

      const res = await fetchRoute(`/tasks/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeoutMinutes: 45, enabled: false }),
      });

      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.data.timeoutMinutes).toBe(45);
      expect(body.data.enabled).toBe(false);
      expect(mockRescheduleTask).toHaveBeenCalled();
    });
  });

  describe("POST /web/tasks/:id/trigger", () => {
    it("returns workspacePath and resultSummary", async () => {
      const id = await createTaskViaRoute();
      expect(id).toBeTruthy();

      const res = await fetchRoute(`/tasks/${id}/trigger`, { method: "POST" });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.workspacePath).toContain(".scheduled-runs");
      expect(body.data.resultSummary).toBe("route summary");
      expect(body.data.triggeredBy).toBe("manual");
    });
  });

  describe("GET /web/tasks/:id/logs", () => {
    it("does not return legacy HTTP log fields", async () => {
      const id = await createTaskViaRoute();
      expect(id).toBeTruthy();
      await fetchRoute(`/tasks/${id}/trigger`, { method: "POST" });

      const res = await fetchRoute(`/tasks/${id}/logs`);
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.items[0].workspacePath).toContain(".scheduled-runs");
      expect("statusCode" in body.data.items[0]).toBe(false);
      expect("responseBody" in body.data.items[0]).toBe(false);
    });
  });
});
