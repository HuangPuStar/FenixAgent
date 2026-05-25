import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import type { CreateTaskRequest, UpdateTaskRequest } from "../../schemas/task.schema";
import { CreateTaskRequestSchema, TaskInfoSchema, UpdateTaskRequestSchema } from "../../schemas/task.schema";
import type { CreateTaskInput } from "../../services/task";
import {
  clearExecutionLogs,
  createTask,
  deleteTask,
  getTask,
  listExecutionLogs,
  listTasks,
  toggleTask,
  triggerTask,
  updateTask,
} from "../../services/task";

const app = new Elysia({ name: "web-tasks" }).use(authGuardPlugin).model({
  "task-info": TaskInfoSchema,
  "task-info-list": TaskInfoSchema.array(),
  "create-task-request": CreateTaskRequestSchema,
  "update-task-request": UpdateTaskRequestSchema,
});

/** GET /tasks — List current team's scheduled tasks */
app.get(
  "/tasks",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, request: _request }: any) => {
    const authCtx = store.authContext!;
    const result = await listTasks(authCtx.organizationId);
    return result;
  },
  { sessionAuth: true },
);

/** POST /tasks — Create a new scheduled task */
app.post(
  "/tasks",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth + body model
  async ({ store, body, error, request: _request }: any) => {
    const authCtx = store.authContext!;
    const payload = body as CreateTaskRequest;
    const result = await createTask(authCtx.organizationId, payload as unknown as CreateTaskInput, authCtx.userId);

    if (!result.success) {
      const err = result.error!;
      const status = err.code === "VALIDATION_ERROR" ? 400 : 500;
      return error(status, { error: { type: "validation_error", message: err.message } });
    }

    return result;
  },
  { sessionAuth: true, body: "create-task-request" },
);

/** 安全执行任务操作，捕获无效 UUID 等 SQL 错误 */
async function safeTaskOp<T>(
  fn: () => Promise<T>,
  errorFn: (status: number, body: unknown) => Response,
): Promise<T | Response> {
  try {
    return await fn();
  } catch (err: unknown) {
    const msg =
      (err instanceof Error && err.cause instanceof Error ? err.cause.message : "") ||
      (err instanceof Error ? err.message : "");
    if (msg.includes("invalid input syntax"))
      return errorFn(404, { error: { type: "not_found", message: "任务不存在" } });
    throw err;
  }
}

/** GET /tasks/:id — Get task detail */
app.get(
  "/tasks/:id",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, params, error, request: _request }: any) => {
    const authCtx = store.authContext!;
    const taskId = params.id;
    return safeTaskOp(async () => {
      const result = await getTask(authCtx.organizationId, taskId);
      if (!result.success) {
        return error(404, { error: { type: "not_found", message: result.error!.message } });
      }
      return result;
    }, error);
  },
  { sessionAuth: true },
);

/** PUT /tasks/:id — Update task configuration */
app.put(
  "/tasks/:id",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth + body model
  async ({ store, params, body, error, request: _request }: any) => {
    const authCtx = store.authContext!;
    const taskId = params.id;
    const payload = body as UpdateTaskRequest;
    return safeTaskOp(async () => {
      const result = await updateTask(authCtx.organizationId, taskId, payload as unknown as Record<string, unknown>);
      if (!result.success) {
        const err = result.error!;
        if (err.code === "NOT_FOUND") {
          return error(404, { error: { type: "not_found", message: err.message } });
        }
        return error(400, { error: { type: "validation_error", message: err.message } });
      }
      return result;
    }, error);
  },
  { sessionAuth: true, body: "update-task-request" },
);

/** DELETE /tasks/:id — Delete a task */
app.delete(
  "/tasks/:id",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, params, error, request: _request }: any) => {
    const authCtx = store.authContext!;
    const taskId = params.id;
    try {
      const result = await deleteTask(authCtx.organizationId, taskId);

      if (!result.success) {
        const err = result.error!;
        return error(404, { error: { type: "not_found", message: err.message } });
      }

      return result;
    } catch (err: unknown) {
      const msg =
        (err instanceof Error && err.cause instanceof Error ? err.cause.message : "") ||
        (err instanceof Error ? err.message : "");
      if (msg.includes("invalid input syntax"))
        return error(404, { error: { type: "not_found", message: "任务不存在" } });
      throw err;
    }
  },
  { sessionAuth: true },
);

/** POST /tasks/:id/toggle — Toggle task enabled/disabled */
app.post(
  "/tasks/:id/toggle",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, params, error, request: _request }: any) => {
    const authCtx = store.authContext!;
    const taskId = params.id;
    return safeTaskOp(async () => {
      const result = await toggleTask(authCtx.organizationId, taskId);
      if (!result.success) return error(404, { error: { type: "not_found", message: result.error!.message } });
      return result;
    }, error);
  },
  { sessionAuth: true },
);

/** POST /tasks/:id/trigger — Manually trigger a task execution */
app.post(
  "/tasks/:id/trigger",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, params, error, request: _request }: any) => {
    const authCtx = store.authContext!;
    const taskId = params.id;
    return safeTaskOp(async () => {
      const result = await triggerTask(authCtx.organizationId, taskId);
      if (!result.success) return error(404, { error: { type: "not_found", message: result.error!.message } });
      return result;
    }, error);
  },
  { sessionAuth: true },
);

/** GET /tasks/:id/logs — Get execution logs (paginated) */
app.get(
  "/tasks/:id/logs",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, params, query, error, request: _request }: any) => {
    const authCtx = store.authContext!;
    const taskId = params.id;
    const q = query as Record<string, string | undefined>;
    return safeTaskOp(async () => {
      const taskResult = await getTask(authCtx.organizationId, taskId);
      if (!taskResult.success) return error(404, { error: { type: "not_found", message: "任务不存在" } });

      const page = Math.max(1, Number(q.page) || 1);
      const pageSize = Math.min(100, Math.max(1, Number(q.pageSize) || 20));
      return await listExecutionLogs(taskId, page, pageSize);
    }, error);
  },
  { sessionAuth: true },
);

/** DELETE /tasks/:id/logs — Clear all execution logs for a task */
app.delete(
  "/tasks/:id/logs",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, params, error, request: _request }: any) => {
    const authCtx = store.authContext!;
    const taskId = params.id;
    return safeTaskOp(async () => {
      const taskResult = await getTask(authCtx.organizationId, taskId);
      if (!taskResult.success) return error(404, { error: { type: "not_found", message: "任务不存在" } });

      return await clearExecutionLogs(authCtx.organizationId, taskId);
    }, error);
  },
  { sessionAuth: true },
);

export default app;
