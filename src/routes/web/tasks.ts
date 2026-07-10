/**
 * @deprecated 本路由已冻结，不再新增或修改功能。请使用 /web/tasks/v2。
 */
import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import { WebErrSchema } from "../../schemas/common.schema";
import type { CreateTaskRequest, UpdateTaskRequest } from "../../schemas/task.schema";
import {
  ClearTaskLogsResponseSchema,
  CreateTaskRequestSchema,
  DeleteTaskResponseSchema,
  PaginatedLogsSchema,
  TaskInfoSchema,
  TaskListResponseSchema,
  TaskLogsResponseSchema,
  TaskResponseSchema,
  ToggleTaskResponseSchema,
  TriggerTaskResponseSchema,
  UpdateTaskRequestSchema,
} from "../../schemas/task.schema";
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
  "clear-task-logs-response": ClearTaskLogsResponseSchema,
  "task-info": TaskInfoSchema,
  "task-info-list": TaskInfoSchema.array(),
  "task-list-response": TaskListResponseSchema,
  "task-response": TaskResponseSchema,
  "task-logs-response": TaskLogsResponseSchema,
  "delete-task-response": DeleteTaskResponseSchema,
  "toggle-task-response": ToggleTaskResponseSchema,
  "trigger-task-response": TriggerTaskResponseSchema,
  "create-task-request": CreateTaskRequestSchema,
  "update-task-request": UpdateTaskRequestSchema,
  "paginated-logs": PaginatedLogsSchema,
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
  {
    sessionAuth: true,
    response: "task-list-response",
    detail: {
      deprecated: true,
      tags: ["Tasks"],
      summary: "获取任务列表",
      description: "返回当前组织下的定时任务列表及其最近执行状态。",
    },
  },
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
      return error(status, { success: false, error: { code: err.code, message: err.message } });
    }

    return result;
  },
  {
    sessionAuth: true,
    body: "create-task-request",
    response: {
      200: "task-response",
      400: WebErrSchema,
      500: WebErrSchema,
    },
    detail: {
      deprecated: true,
      tags: ["Tasks"],
      summary: "创建任务",
      description: "创建一个新的定时 HTTP 任务，并在启用状态下注册到调度器。",
    },
  },
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
      return errorFn(404, { success: false, error: { code: "not_found", message: "任务不存在" } });
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
        return error(404, { success: false, error: { code: "not_found", message: result.error!.message } });
      }
      return result;
    }, error);
  },
  {
    sessionAuth: true,
    response: {
      200: "task-response",
      404: WebErrSchema,
    },
    detail: {
      deprecated: true,
      tags: ["Tasks"],
      summary: "获取任务详情",
      description: "根据任务 ID 获取单个任务的完整配置与状态信息。",
    },
  },
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
          return error(404, { success: false, error: { code: "not_found", message: err.message } });
        }
        return error(400, { success: false, error: { code: "validation_error", message: err.message } });
      }
      return result;
    }, error);
  },
  {
    sessionAuth: true,
    body: "update-task-request",
    response: {
      200: "task-response",
      400: WebErrSchema,
      404: WebErrSchema,
    },
    detail: {
      deprecated: true,
      tags: ["Tasks"],
      summary: "更新任务",
      description: "更新任务配置；当 cron、时区或启用状态变化时会重新调度。",
    },
  },
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
        return error(404, { success: false, error: { code: "not_found", message: err.message } });
      }

      return { success: true as const, data: null };
    } catch (err: unknown) {
      const msg =
        (err instanceof Error && err.cause instanceof Error ? err.cause.message : "") ||
        (err instanceof Error ? err.message : "");
      if (msg.includes("invalid input syntax"))
        return error(404, { success: false, error: { code: "not_found", message: "任务不存在" } });
      throw err;
    }
  },
  {
    sessionAuth: true,
    response: {
      200: "delete-task-response",
      404: WebErrSchema,
    },
    detail: {
      deprecated: true,
      tags: ["Tasks"],
      summary: "删除任务",
      description: "删除指定任务，并同步取消其调度。",
    },
  },
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
      if (!result.success)
        return error(404, { success: false, error: { code: "not_found", message: result.error!.message } });
      return result;
    }, error);
  },
  {
    sessionAuth: true,
    response: {
      200: "toggle-task-response",
      404: WebErrSchema,
    },
    detail: {
      deprecated: true,
      tags: ["Tasks"],
      summary: "切换任务启用状态",
      description: "在启用与停用之间切换任务状态，并同步更新调度器。",
    },
  },
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
      if (!result.success)
        return error(404, { success: false, error: { code: "not_found", message: result.error!.message } });
      return result;
    }, error);
  },
  {
    sessionAuth: true,
    response: {
      200: "trigger-task-response",
      404: WebErrSchema,
    },
    detail: {
      deprecated: true,
      tags: ["Tasks"],
      summary: "手动触发任务",
      description: "立即执行一次指定任务，并返回本次执行生成的日志摘要。",
    },
  },
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
      if (!taskResult.success)
        return error(404, { success: false, error: { code: "not_found", message: "任务不存在" } });

      const page = Math.max(1, Number(q.page) || 1);
      const pageSize = Math.min(100, Math.max(1, Number(q.pageSize) || 20));
      return await listExecutionLogs(taskId, page, pageSize);
    }, error);
  },
  {
    sessionAuth: true,
    response: {
      200: "task-logs-response",
      404: WebErrSchema,
    },
    detail: {
      deprecated: true,
      tags: ["Tasks"],
      summary: "获取任务执行日志",
      description: "分页返回指定任务的执行日志记录。",
    },
  },
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
      if (!taskResult.success)
        return error(404, { success: false, error: { code: "not_found", message: "任务不存在" } });

      const result = await clearExecutionLogs(authCtx.organizationId, taskId);
      if (!result.success) {
        return error(404, { success: false, error: { code: "not_found", message: "任务不存在" } });
      }
      return { success: true as const, data: null };
    }, error);
  },
  {
    sessionAuth: true,
    response: {
      200: "clear-task-logs-response",
      404: WebErrSchema,
    },
    detail: {
      deprecated: true,
      tags: ["Tasks"],
      summary: "清空任务日志",
      description: "删除指定任务下的全部执行日志记录。",
    },
  },
);

export default app;
