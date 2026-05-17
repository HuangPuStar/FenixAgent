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
import {
  TaskInfoSchema,
  CreateTaskRequestSchema,
  UpdateTaskRequestSchema,
} from "../../schemas/task.schema";
import { loadTeamContext } from "../../services/team-context";

const app = new Elysia({ name: "web-tasks", prefix: "/web" })
  .use(authGuardPlugin)
  .model({
    "task-info": TaskInfoSchema,
    "task-info-list": TaskInfoSchema.array(),
    "create-task-request": CreateTaskRequestSchema,
    "update-task-request": UpdateTaskRequestSchema,
  });

/** GET /tasks — List current team's scheduled tasks */
app.get("/tasks", async ({ store, request }: any) => {
  const authCtx = (await loadTeamContext(store.user!, request))!;
  const result = await listTasks(authCtx.teamId);
  return result;
}, { sessionAuth: true });

/** POST /tasks — Create a new scheduled task */
app.post("/tasks", async ({ store, body, error, request }: any) => {
  const authCtx = (await loadTeamContext(store.user!, request as any))!;
  const payload = body as Record<string, unknown>;
  const result = await createTask(authCtx.teamId, payload as any, authCtx.userId);

  if (!result.success) {
    const err = result.error!;
    const status = err.code === "VALIDATION_ERROR" ? 400 : 500;
    return error(status, { error: { type: "validation_error", message: err.message } });
  }

  return result;
}, { sessionAuth: true, body: "create-task-request" });

/** 安全执行任务操作，捕获无效 UUID 等 SQL 错误 */
async function safeTaskOp<T>(fn: () => Promise<T>, errorFn: (status: number, body: unknown) => any): Promise<T | Response> {
  try {
    return await fn();
  } catch (err: any) {
    const msg = err.cause?.message || err.message || "";
    if (msg.includes("invalid input syntax")) return errorFn(404, { error: { type: "not_found", message: "任务不存在" } });
    throw err;
  }
}

/** GET /tasks/:id — Get task detail */
app.get("/tasks/:id", async ({ store, params, error, request }: any) => {
  const authCtx = (await loadTeamContext(store.user!, request as any))!;
  const taskId = params.id;
  return safeTaskOp(async () => {
    const result = await getTask(authCtx.teamId, taskId);
    if (!result.success) {
      return error(404, { error: { type: "not_found", message: result.error!.message } });
    }
    return result;
  }, error);
}, { sessionAuth: true });

/** PUT /tasks/:id — Update task configuration */
app.put("/tasks/:id", async ({ store, params, body, error, request }: any) => {
  const authCtx = (await loadTeamContext(store.user!, request as any))!;
  const taskId = params.id;
  const payload = body as Record<string, unknown>;
  return safeTaskOp(async () => {
    const result = await updateTask(authCtx.teamId, taskId, payload);
    if (!result.success) {
      const err = result.error!;
      if (err.code === "NOT_FOUND") {
        return error(404, { error: { type: "not_found", message: err.message } });
      }
      return error(400, { error: { type: "validation_error", message: err.message } });
    }
    return result;
  }, error);
}, { sessionAuth: true, body: "update-task-request" });

/** DELETE /tasks/:id — Delete a task */
app.delete("/tasks/:id", async ({ store, params, error, request }: any) => {
  const authCtx = (await loadTeamContext(store.user!, request as any))!;
  const taskId = params.id;
  try {
    const result = await deleteTask(authCtx.teamId, taskId);

    if (!result.success) {
      const err = result.error!;
      return error(404, { error: { type: "not_found", message: err.message } });
    }

    return result;
  } catch (err: any) {
    const msg = err.cause?.message || err.message || "";
    if (msg.includes("invalid input syntax")) return error(404, { error: { type: "not_found", message: "任务不存在" } });
    throw err;
  }
}, { sessionAuth: true });

/** POST /tasks/:id/toggle — Toggle task enabled/disabled */
app.post("/tasks/:id/toggle", async ({ store, params, error, request }: any) => {
  const authCtx = (await loadTeamContext(store.user!, request as any))!;
  const taskId = params.id;
  return safeTaskOp(async () => {
    const result = await toggleTask(authCtx.teamId, taskId);
    if (!result.success) return error(404, { error: { type: "not_found", message: result.error!.message } });
    return result;
  }, error);
}, { sessionAuth: true });

/** POST /tasks/:id/trigger — Manually trigger a task execution */
app.post("/tasks/:id/trigger", async ({ store, params, error, request }: any) => {
  const authCtx = (await loadTeamContext(store.user!, request as any))!;
  const taskId = params.id;
  return safeTaskOp(async () => {
    const result = await triggerTask(authCtx.teamId, taskId);
    if (!result.success) return error(404, { error: { type: "not_found", message: result.error!.message } });
    return result;
  }, error);
}, { sessionAuth: true });

/** GET /tasks/:id/logs — Get execution logs (paginated) */
app.get("/tasks/:id/logs", async ({ store, params, query, error, request }: any) => {
  const authCtx = (await loadTeamContext(store.user!, request as any))!;
  const taskId = params.id;
  return safeTaskOp(async () => {
    const taskResult = await getTask(authCtx.teamId, taskId);
    if (!taskResult.success) return error(404, { error: { type: "not_found", message: "任务不存在" } });

    const page = Math.max(1, Number((query as any)?.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number((query as any)?.pageSize) || 20));
    return await listExecutionLogs(taskId, page, pageSize);
  }, error);
}, { sessionAuth: true });

/** DELETE /tasks/:id/logs — Clear all execution logs for a task */
app.delete("/tasks/:id/logs", async ({ store, params, error, request }: any) => {
  const authCtx = (await loadTeamContext(store.user!, request as any))!;
  const taskId = params.id;
  return safeTaskOp(async () => {
    const taskResult = await getTask(authCtx.teamId, taskId);
    if (!taskResult.success) return error(404, { error: { type: "not_found", message: "任务不存在" } });

    return await clearExecutionLogs(authCtx.teamId, taskId);
  }, error);
}, { sessionAuth: true });

export default app;
