import { describe, it, expect, mock } from "bun:test";

// Mock auth middleware — pass-through
mock.module("../auth/middleware", () => ({
  sessionAuth: mock(async (c: any, next: any) => {
    c.set("user", { id: "test_user" });
    await next();
  }),
}));

// Mock task service functions
const mockListTasks = mock(() => Promise.resolve({ success: true, data: [] }));
const mockCreateTask = mock(() => Promise.resolve({ success: true, data: { id: "task_xxx", cron: "*/5 * * * *" } }));
const mockGetTask = mock(() => Promise.resolve({ success: true, data: { id: "task_xxx" } }));
const mockUpdateTask = mock(() => Promise.resolve({ success: true, data: { id: "task_xxx" } }));
const mockDeleteTask = mock(() => Promise.resolve({ success: true }));
const mockToggleTask = mock(() => Promise.resolve({ success: true, data: { id: "task_xxx", enabled: true } }));
const mockTriggerTask = mock(() => Promise.resolve({ success: true, data: { id: "log_xxx", status: "success", duration: 150 } }));
const mockListExecutionLogs = mock(() => Promise.resolve({ success: true, data: { total: 0, items: [] } }));
const mockClearExecutionLogs = mock(() => Promise.resolve({ success: true }));

mock.module("../services/task", () => ({
  listTasks: mockListTasks,
  createTask: mockCreateTask,
  getTask: mockGetTask,
  updateTask: mockUpdateTask,
  deleteTask: mockDeleteTask,
  toggleTask: mockToggleTask,
  triggerTask: mockTriggerTask,
  listExecutionLogs: mockListExecutionLogs,
  clearExecutionLogs: mockClearExecutionLogs,
}));

// Mock scheduler functions
const mockScheduleTask = mock(() => {});
const mockUnscheduleTask = mock(() => {});
const mockRescheduleTask = mock(() => {});

mock.module("../services/scheduler", () => ({
  scheduleTask: mockScheduleTask,
  unscheduleTask: mockUnscheduleTask,
  rescheduleTask: mockRescheduleTask,
}));

const app = (await import("../routes/web/tasks")).default;

async function fetch(path: string, options: any = {}) {
  return app.fetch(new Request(`http://localhost${path}`, options));
}

describe("Task Routes", () => {
  describe("GET /web/tasks", () => {
    it("should return task list", async () => {
      const res = await fetch("/tasks");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });
  });

  describe("POST /web/tasks", () => {
    it("should create a task and schedule it", async () => {
      const res = await fetch("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Test", cron: "*/5 * * * *", url: "https://example.com" }),
      });
      expect(res.status).toBe(201);
      expect(mockScheduleTask).toHaveBeenCalled();
    });

    it("should return 400 on validation error", async () => {
      mockCreateTask.mockImplementationOnce(() => Promise.resolve({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "cron 表达式必须为 5 字段" },
      }));
      const res = await fetch("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Test", cron: "bad", url: "https://example.com" }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /web/tasks/:id", () => {
    it("should return task detail", async () => {
      const res = await fetch("/tasks/task_xxx");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it("should return 404 for not found", async () => {
      mockGetTask.mockImplementationOnce(() => Promise.resolve({
        success: false,
        error: { code: "NOT_FOUND", message: "任务不存在" },
      }));
      const res = await fetch("/tasks/task_nonexistent");
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /web/tasks/:id", () => {
    it("should update a task and reschedule", async () => {
      const res = await fetch("/tasks/task_xxx", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Updated" }),
      });
      expect(res.status).toBe(200);
      expect(mockRescheduleTask).toHaveBeenCalled();
    });

    it("should return 404 for not found", async () => {
      mockUpdateTask.mockImplementationOnce(() => Promise.resolve({
        success: false,
        error: { code: "NOT_FOUND", message: "任务不存在" },
      }));
      const res = await fetch("/tasks/task_nonexistent", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "X" }),
      });
      expect(res.status).toBe(404);
    });

    it("should return 400 on validation error", async () => {
      mockUpdateTask.mockImplementationOnce(() => Promise.resolve({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "URL 格式错误" },
      }));
      const res = await fetch("/tasks/task_xxx", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "ftp://bad" }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /web/tasks/:id", () => {
    it("should delete a task and unschedule", async () => {
      const res = await fetch("/tasks/task_xxx", { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(mockUnscheduleTask).toHaveBeenCalled();
    });

    it("should return 404 for not found", async () => {
      mockDeleteTask.mockImplementationOnce(() => Promise.resolve({
        success: false,
        error: { code: "NOT_FOUND", message: "任务不存在" },
      }));
      const res = await fetch("/tasks/task_nonexistent", { method: "DELETE" });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /web/tasks/:id/toggle", () => {
    it("should enable task and schedule", async () => {
      mockToggleTask.mockImplementationOnce(() => Promise.resolve({
        success: true,
        data: { id: "task_xxx", enabled: true },
      }));
      const res = await fetch("/tasks/task_xxx/toggle", { method: "POST" });
      expect(res.status).toBe(200);
      expect(mockScheduleTask).toHaveBeenCalled();
    });

    it("should disable task and unschedule", async () => {
      mockToggleTask.mockImplementationOnce(() => Promise.resolve({
        success: true,
        data: { id: "task_xxx", enabled: false },
      }));
      const res = await fetch("/tasks/task_xxx/toggle", { method: "POST" });
      expect(res.status).toBe(200);
      expect(mockUnscheduleTask).toHaveBeenCalled();
    });

    it("should return 404 for not found", async () => {
      mockToggleTask.mockImplementationOnce(() => Promise.resolve({
        success: false,
        error: { code: "NOT_FOUND", message: "任务不存在" },
      }));
      const res = await fetch("/tasks/task_nonexistent/toggle", { method: "POST" });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /web/tasks/:id/trigger", () => {
    it("should trigger task and return result", async () => {
      const res = await fetch("/tasks/task_xxx/trigger", { method: "POST" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it("should return 404 for not found", async () => {
      mockTriggerTask.mockImplementationOnce(() => Promise.resolve({
        success: false,
        error: { code: "NOT_FOUND", message: "任务不存在" },
      }));
      const res = await fetch("/tasks/task_nonexistent/trigger", { method: "POST" });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /web/tasks/:id/logs", () => {
    it("should return paginated logs", async () => {
      const res = await fetch("/tasks/task_xxx/logs");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it("should return 404 for non-owned task", async () => {
      mockGetTask.mockImplementationOnce(() => Promise.resolve({
        success: false,
        error: { code: "NOT_FOUND", message: "任务不存在" },
      }));
      const res = await fetch("/tasks/task_nonexistent/logs");
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /web/tasks/:id/logs", () => {
    it("should clear logs", async () => {
      const res = await fetch("/tasks/task_xxx/logs", { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(mockClearExecutionLogs).toHaveBeenCalled();
    });

    it("should return 404 for non-owned task", async () => {
      mockGetTask.mockImplementationOnce(() => Promise.resolve({
        success: false,
        error: { code: "NOT_FOUND", message: "任务不存在" },
      }));
      const res = await fetch("/tasks/task_nonexistent/logs", { method: "DELETE" });
      expect(res.status).toBe(404);
    });
  });
});
