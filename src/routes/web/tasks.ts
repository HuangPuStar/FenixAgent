import { Hono } from "hono";
import { sessionAuth } from "../../auth/middleware";
import {
  listTasks,
  createTask,
  getTask,
  updateTask,
  deleteTask,
  toggleTask,
  triggerTask,
  listExecutionLogs,
  clearExecutionLogs,
} from "../../services/task";
import { scheduleTask, unscheduleTask, rescheduleTask } from "../../services/scheduler";

const app = new Hono();

/** GET /tasks — List current user's scheduled tasks */
app.get("/tasks", sessionAuth, async (c) => {
  const user = c.get("user")!;
  const result = await listTasks(user.id);
  return c.json(result);
});

/** POST /tasks — Create a new scheduled task */
app.post("/tasks", sessionAuth, async (c) => {
  const user = c.get("user")!;
  const payload = await c.req.json().catch(() => ({}));
  const result = await createTask(user.id, payload);

  if (!result.success) {
    const err = result.error!;
    const status = err.code === "VALIDATION_ERROR" ? 400 : 500;
    return c.json({ error: { type: "validation_error", message: err.message } }, status);
  }

  const task = result.data!;
  scheduleTask({ id: task.id, cron: task.cron, timezone: task.timezone, enabled: task.enabled });

  return c.json(result, 201);
});

/** GET /tasks/:id — Get task detail */
app.get("/tasks/:id", sessionAuth, async (c) => {
  const user = c.get("user")!;
  const taskId = c.req.param("id")!;
  const result = await getTask(user.id, taskId);

  if (!result.success) {
    const err = result.error!;
    return c.json({ error: { type: "not_found", message: err.message } }, 404);
  }

  return c.json(result);
});

/** PUT /tasks/:id — Update task configuration */
app.put("/tasks/:id", sessionAuth, async (c) => {
  const user = c.get("user")!;
  const taskId = c.req.param("id")!;
  const payload = await c.req.json().catch(() => ({}));
  const result = await updateTask(user.id, taskId, payload);

  if (!result.success) {
    const err = result.error!;
    if (err.code === "NOT_FOUND") {
      return c.json({ error: { type: "not_found", message: err.message } }, 404);
    }
    return c.json({ error: { type: "validation_error", message: err.message } }, 400);
  }

  const task = result.data!;
  rescheduleTask({ id: task.id, cron: task.cron, timezone: task.timezone, enabled: task.enabled });

  return c.json(result);
});

/** DELETE /tasks/:id — Delete a task */
app.delete("/tasks/:id", sessionAuth, async (c) => {
  const user = c.get("user")!;
  const taskId = c.req.param("id")!;
  const result = await deleteTask(user.id, taskId);

  if (!result.success) {
    const err = result.error!;
    return c.json({ error: { type: "not_found", message: err.message } }, 404);
  }

  unscheduleTask(taskId);

  return c.json(result);
});

/** POST /tasks/:id/toggle — Toggle task enabled/disabled */
app.post("/tasks/:id/toggle", sessionAuth, async (c) => {
  const user = c.get("user")!;
  const taskId = c.req.param("id")!;
  const result = await toggleTask(user.id, taskId);

  if (!result.success) {
    const err = result.error!;
    return c.json({ error: { type: "not_found", message: err.message } }, 404);
  }

  if (result.data!.enabled) {
    const taskResult = await getTask(user.id, taskId);
    if (taskResult.success && taskResult.data) {
      const task = taskResult.data;
      scheduleTask({ id: task.id, cron: task.cron, timezone: task.timezone, enabled: task.enabled });
    }
  } else {
    unscheduleTask(taskId);
  }

  return c.json(result);
});

/** POST /tasks/:id/trigger — Manually trigger a task execution */
app.post("/tasks/:id/trigger", sessionAuth, async (c) => {
  const user = c.get("user")!;
  const taskId = c.req.param("id")!;
  const result = await triggerTask(user.id, taskId);

  if (!result.success) {
    const err = result.error!;
    return c.json({ error: { type: "not_found", message: err.message } }, 404);
  }

  return c.json(result);
});

/** GET /tasks/:id/logs — Get execution logs (paginated) */
app.get("/tasks/:id/logs", sessionAuth, async (c) => {
  const user = c.get("user")!;
  const taskId = c.req.param("id")!;

  const taskResult = await getTask(user.id, taskId);
  if (!taskResult.success) {
    return c.json({ error: { type: "not_found", message: "任务不存在" } }, 404);
  }

  const page = Math.max(1, Number(c.req.query("page")) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(c.req.query("pageSize")) || 20));
  const result = await listExecutionLogs(taskId, page, pageSize);

  return c.json(result);
});

/** DELETE /tasks/:id/logs — Clear all execution logs for a task */
app.delete("/tasks/:id/logs", sessionAuth, async (c) => {
  const user = c.get("user")!;
  const taskId = c.req.param("id")!;

  const taskResult = await getTask(user.id, taskId);
  if (!taskResult.success) {
    return c.json({ error: { type: "not_found", message: "任务不存在" } }, 404);
  }

  const result = await clearExecutionLogs(taskId);
  return c.json(result);
});

export default app;
