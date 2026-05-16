import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
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
import {
  TaskInfoSchema,
  CreateTaskRequestSchema,
  UpdateTaskRequestSchema,
} from "../../schemas/task.schema";

const app = new Elysia({ name: "web-tasks", prefix: "/web" })
  .use(authGuardPlugin)
  .model({
    "task-info": TaskInfoSchema,
    "task-info-list": TaskInfoSchema.array(),
    "create-task-request": CreateTaskRequestSchema,
    "update-task-request": UpdateTaskRequestSchema,
  });

/** GET /tasks — List current user's scheduled tasks */
app.get("/tasks", async ({ store }) => {
  const user = store.user!;
  const result = await listTasks(user.id);
  return result;
}, { sessionAuth: true });

/** POST /tasks — Create a new scheduled task */
app.post("/tasks", async ({ store, body, error }) => {
  const user = store.user!;
  const payload = body as Record<string, unknown>;
  const result = await createTask(user.id, payload as any);

  if (!result.success) {
    const err = result.error!;
    const status = err.code === "VALIDATION_ERROR" ? 400 : 500;
    return error(status, { error: { type: "validation_error", message: err.message } });
  }

  const task = result.data!;
  scheduleTask({ id: task.id, cron: task.cron, timezone: task.timezone, enabled: task.enabled });

  return result;
}, { sessionAuth: true, body: "create-task-request" });

/** GET /tasks/:id — Get task detail */
app.get("/tasks/:id", async ({ store, params, error }) => {
  const user = store.user!;
  const taskId = params.id;
  const result = await getTask(user.id, taskId);

  if (!result.success) {
    const err = result.error!;
    return error(404, { error: { type: "not_found", message: err.message } });
  }

  return result;
}, { sessionAuth: true });

/** PUT /tasks/:id — Update task configuration */
app.put("/tasks/:id", async ({ store, params, body, error }) => {
  const user = store.user!;
  const taskId = params.id;
  const payload = body as Record<string, unknown>;
  const result = await updateTask(user.id, taskId, payload);

  if (!result.success) {
    const err = result.error!;
    if (err.code === "NOT_FOUND") {
      return error(404, { error: { type: "not_found", message: err.message } });
    }
    return error(400, { error: { type: "validation_error", message: err.message } });
  }

  const task = result.data!;
  rescheduleTask({ id: task.id, cron: task.cron, timezone: task.timezone, enabled: task.enabled });

  return result;
}, { sessionAuth: true, body: "update-task-request" });

/** DELETE /tasks/:id — Delete a task */
app.delete("/tasks/:id", async ({ store, params, error }) => {
  const user = store.user!;
  const taskId = params.id;
  const result = await deleteTask(user.id, taskId);

  if (!result.success) {
    const err = result.error!;
    return error(404, { error: { type: "not_found", message: err.message } });
  }

  unscheduleTask(taskId);

  return result;
}, { sessionAuth: true });

/** POST /tasks/:id/toggle — Toggle task enabled/disabled */
app.post("/tasks/:id/toggle", async ({ store, params, error }) => {
  const user = store.user!;
  const taskId = params.id;
  const result = await toggleTask(user.id, taskId);

  if (!result.success) {
    const err = result.error!;
    return error(404, { error: { type: "not_found", message: err.message } });
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

  return result;
}, { sessionAuth: true });

/** POST /tasks/:id/trigger — Manually trigger a task execution */
app.post("/tasks/:id/trigger", async ({ store, params, error }) => {
  const user = store.user!;
  const taskId = params.id;
  const result = await triggerTask(user.id, taskId);

  if (!result.success) {
    const err = result.error!;
    return error(404, { error: { type: "not_found", message: err.message } });
  }

  return result;
}, { sessionAuth: true });

/** GET /tasks/:id/logs — Get execution logs (paginated) */
app.get("/tasks/:id/logs", async ({ store, params, query, error }) => {
  const user = store.user!;
  const taskId = params.id;

  const taskResult = await getTask(user.id, taskId);
  if (!taskResult.success) {
    return error(404, { error: { type: "not_found", message: "任务不存在" } });
  }

  const page = Math.max(1, Number((query as any)?.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number((query as any)?.pageSize) || 20));
  const result = await listExecutionLogs(taskId, page, pageSize);

  return result;
}, { sessionAuth: true });

/** DELETE /tasks/:id/logs — Clear all execution logs for a task */
app.delete("/tasks/:id/logs", async ({ store, params, error }) => {
  const user = store.user!;
  const taskId = params.id;

  const taskResult = await getTask(user.id, taskId);
  if (!taskResult.success) {
    return error(404, { error: { type: "not_found", message: "任务不存在" } });
  }

  const result = await clearExecutionLogs(taskId);
  return result;
}, { sessionAuth: true });

export default app;
