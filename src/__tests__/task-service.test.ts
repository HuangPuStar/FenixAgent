import { describe, it, expect, beforeEach, mock, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../db/schema";
import {
  createTask,
  listTasks,
  getTask,
  updateTask,
  deleteTask,
  toggleTask,
  listExecutionLogs,
  clearExecutionLogs,
  getTaskById,
  createExecutionLog,
} from "../services/task";

let testDb: ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database;

const TEST_SQL = `
CREATE TABLE IF NOT EXISTS user (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduled_task (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  cron TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  enabled INTEGER NOT NULL DEFAULT 1,
  url TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'GET',
  headers TEXT,
  body TEXT,
  timeout INTEGER NOT NULL DEFAULT 30000,
  retry_enabled INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 3,
  retry_interval INTEGER NOT NULL DEFAULT 60,
  last_run_at INTEGER,
  next_run_at INTEGER,
  last_status TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_execution_log (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES scheduled_task(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  status_code INTEGER,
  response_body TEXT,
  error TEXT,
  duration INTEGER,
  attempt INTEGER NOT NULL DEFAULT 1,
  triggered_by TEXT NOT NULL DEFAULT 'cron',
  created_at INTEGER NOT NULL
);
`;

const USER_A = "user_a";
const USER_B = "user_b";

// We need to mock the db import from "../db"
const originalModule = await import("../db");

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec(TEST_SQL);
  testDb = drizzle(sqlite, { schema });

  // Insert test users
  sqlite.run(`INSERT INTO user VALUES ('${USER_A}', 'Alice', 'alice@test.com', 0, NULL, 1, 1)`);
  sqlite.run(`INSERT INTO user VALUES ('${USER_B}', 'Bob', 'bob@test.com', 0, NULL, 1, 1)`);

  // Mock the db module
  mock.module("../db", () => ({
    db: testDb,
  }));
});

afterEach(() => {
  sqlite.close();
  mock.restore();
});

function getValidInput() {
  return {
    name: "Test Task",
    cron: "*/5 * * * *",
    url: "https://httpbin.org/get",
    method: "GET" as const,
  };
}

describe("Task Service", () => {
  describe("createTask", () => {
    it("should create a task successfully", async () => {
      const result = await createTask(USER_A, getValidInput());
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toMatch(/^task_/);
        expect(result.data.name).toBe("Test Task");
        expect(result.data.cron).toBe("*/5 * * * *");
        expect(result.data.enabled).toBe(true);
        expect(result.data.method).toBe("GET");
      }
    });

    it("should reject invalid cron expression", async () => {
      const result = await createTask(USER_A, { ...getValidInput(), cron: "abc" });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
      }
    });

    it("should reject 6-field cron expression", async () => {
      const result = await createTask(USER_A, { ...getValidInput(), cron: "0 */5 * * * *" });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
      }
    });
  });

  describe("listTasks", () => {
    it("should list tasks for the user", async () => {
      await createTask(USER_A, { ...getValidInput(), name: "Task A1" });
      await createTask(USER_A, { ...getValidInput(), name: "Task A2" });
      await createTask(USER_B, { ...getValidInput(), name: "Task B1" });

      const result = await listTasks(USER_A);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.length).toBe(2);
        expect(result.data.every((t) => t.name.startsWith("Task A"))).toBe(true);
      }
    });
  });

  describe("getTask", () => {
    it("should get a task by id", async () => {
      const created = await createTask(USER_A, getValidInput());
      if (!created.success) return;
      const result = await getTask(USER_A, created.data.id);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe("Test Task");
      }
    });

    it("should return NOT_FOUND for non-existent task", async () => {
      const result = await getTask(USER_A, "task_nonexistent");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });

    it("should return NOT_FOUND for other user's task", async () => {
      const created = await createTask(USER_A, getValidInput());
      if (!created.success) return;
      const result = await getTask(USER_B, created.data.id);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });
  });

  describe("updateTask", () => {
    it("should update task name", async () => {
      const created = await createTask(USER_A, getValidInput());
      if (!created.success) return;
      const result = await updateTask(USER_A, created.data.id, { name: "Updated Task" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe("Updated Task");
      }
    });

    it("should reject invalid url", async () => {
      const created = await createTask(USER_A, getValidInput());
      if (!created.success) return;
      const result = await updateTask(USER_A, created.data.id, { url: "ftp://invalid" });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
      }
    });

    it("should return NOT_FOUND for non-existent task", async () => {
      const result = await updateTask(USER_A, "task_nonexistent", { name: "X" });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });
  });

  describe("deleteTask", () => {
    it("should delete a task", async () => {
      const created = await createTask(USER_A, getValidInput());
      if (!created.success) return;
      const result = await deleteTask(USER_A, created.data.id);
      expect(result.success).toBe(true);

      const get = await getTask(USER_A, created.data.id);
      expect(get.success).toBe(false);
    });

    it("should cascade delete execution logs", async () => {
      const created = await createTask(USER_A, getValidInput());
      if (!created.success) return;
      await createExecutionLog({ taskId: created.data.id, status: "success" });
      await createExecutionLog({ taskId: created.data.id, status: "failed" });

      await deleteTask(USER_A, created.data.id);

      const logs = await listExecutionLogs(created.data.id);
      if (logs.success) {
        expect(logs.data.total).toBe(0);
      }
    });
  });

  describe("toggleTask", () => {
    it("should toggle from enabled to disabled", async () => {
      const created = await createTask(USER_A, getValidInput());
      if (!created.success) return;
      const result = await toggleTask(USER_A, created.data.id);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.enabled).toBe(false);
      }
    });

    it("should toggle from disabled to enabled", async () => {
      const created = await createTask(USER_A, getValidInput());
      if (!created.success) return;
      await toggleTask(USER_A, created.data.id);
      const result = await toggleTask(USER_A, created.data.id);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.enabled).toBe(true);
      }
    });

    it("should return NOT_FOUND for non-existent task", async () => {
      const result = await toggleTask(USER_A, "task_nonexistent");
      expect(result.success).toBe(false);
    });
  });

  describe("listExecutionLogs", () => {
    it("should return paginated logs", async () => {
      const created = await createTask(USER_A, getValidInput());
      if (!created.success) return;
      for (let i = 0; i < 25; i++) {
        await createExecutionLog({ taskId: created.data.id, status: "success" });
      }

      const page1 = await listExecutionLogs(created.data.id, 1, 20);
      if (page1.success) {
        expect(page1.data.total).toBe(25);
        expect(page1.data.items.length).toBe(20);
      }

      const page2 = await listExecutionLogs(created.data.id, 2, 20);
      if (page2.success) {
        expect(page2.data.items.length).toBe(5);
      }
    });
  });

  describe("clearExecutionLogs", () => {
    it("should clear all logs for a task", async () => {
      const created = await createTask(USER_A, getValidInput());
      if (!created.success) return;
      await createExecutionLog({ taskId: created.data.id, status: "success" });
      await createExecutionLog({ taskId: created.data.id, status: "success" });
      await createExecutionLog({ taskId: created.data.id, status: "success" });

      await clearExecutionLogs(created.data.id);

      const logs = await listExecutionLogs(created.data.id);
      if (logs.success) {
        expect(logs.data.total).toBe(0);
      }
    });
  });

  describe("createExecutionLog", () => {
    it("should create a log entry", async () => {
      const created = await createTask(USER_A, getValidInput());
      if (!created.success) return;
      const logId = await createExecutionLog({
        taskId: created.data.id,
        status: "success",
        statusCode: 200,
        duration: 150,
      });
      expect(logId).toMatch(/^log_/);

      const logs = await listExecutionLogs(created.data.id);
      if (logs.success) {
        expect(logs.data.total).toBe(1);
        expect(logs.data.items[0].status).toBe("success");
        expect(logs.data.items[0].statusCode).toBe(200);
        expect(logs.data.items[0].duration).toBe(150);
      }
    });

    it("should truncate responseBody to 4096 characters", async () => {
      const created = await createTask(USER_A, getValidInput());
      if (!created.success) return;
      const longBody = "x".repeat(5000);
      await createExecutionLog({
        taskId: created.data.id,
        status: "success",
        responseBody: longBody,
      });

      const logs = await listExecutionLogs(created.data.id);
      if (logs.success) {
        expect(logs.data.items[0].responseBody!.length).toBe(4096);
      }
    });
  });

  describe("getTaskById", () => {
    it("should return task without userId check", async () => {
      const created = await createTask(USER_A, getValidInput());
      if (!created.success) return;
      const task = await getTaskById(created.data.id);
      expect(task).toBeTruthy();
      expect(task!.id).toBe(created.data.id);
    });

    it("should return null for non-existent task", async () => {
      const task = await getTaskById("task_nonexistent");
      expect(task).toBeNull();
    });
  });

  describe("sanitizeTask header masking", () => {
    it("should mask sensitive headers", async () => {
      const created = await createTask(USER_A, {
        ...getValidInput(),
        headers: {
          Authorization: "Bearer secret1234",
          "Content-Type": "application/json",
        },
      });
      expect(created.success).toBe(true);
      if (created.success) {
        expect(created.data.headers!["Authorization"]).toBe("***1234");
        expect(created.data.headers!["Content-Type"]).toBe("application/json");
      }
    });
  });
});
