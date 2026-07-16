import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import { WebErrSchema } from "../../schemas/common.schema";
import type { CreateTaskV2Request, UpdateTaskV2Request } from "../../schemas/task-v2.schema";
import {
  ClearLogsV2ResponseSchema,
  CreateTaskV2RequestSchema,
  DeleteV2ResponseSchema,
  TaskV2InfoSchema,
  TaskV2ListResponseSchema,
  TaskV2LogsResponseSchema,
  TaskV2ResponseSchema,
  ToggleV2ResponseSchema,
  TriggerV2ResponseSchema,
  UpdateTaskV2RequestSchema,
} from "../../schemas/task-v2.schema";
import type { CreateTaskV2Input } from "../../services/task-v2";
import {
  clearExecutionLogsV2,
  createTaskV2,
  deleteTaskV2,
  getTaskV2,
  listExecutionLogsV2,
  listTasksV2,
  toggleTaskV2,
  triggerTaskV2,
  updateTaskV2,
} from "../../services/task-v2";

const app = new Elysia({ name: "web-tasks-v2" }).use(authGuardPlugin).model({
  "task-v2-info": TaskV2InfoSchema,
  "task-v2-info-list": TaskV2InfoSchema.array(),
  "task-v2-response": TaskV2ResponseSchema,
  "task-v2-list-response": TaskV2ListResponseSchema,
  "create-task-v2-request": CreateTaskV2RequestSchema,
  "update-task-v2-request": UpdateTaskV2RequestSchema,
  "trigger-v2-response": TriggerV2ResponseSchema,
  "toggle-v2-response": ToggleV2ResponseSchema,
  "delete-v2-response": DeleteV2ResponseSchema,
  "task-v2-logs-response": TaskV2LogsResponseSchema,
  "clear-task-v2-logs-response": ClearLogsV2ResponseSchema,
});

/** 安全执行：捕获无效 UUID 等 SQL 错误 */
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

// ── GET /tasks/v2 ──
app.get(
  "/tasks/v2",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia handler 参数类型推断受限
  async ({ store, query }: any) => {
    const authCtx = store.authContext!;
    const q = query as Record<string, string | undefined>;
    const page = Number(q.page) || 1;
    const pageSize = Number(q.pageSize) || 20;
    const keyword = q.keyword || undefined;
    const type = q.type || undefined;
    const agentId = q.agentId || undefined;
    return await listTasksV2(authCtx.userId, authCtx.organizationId, page, pageSize, {
      keyword,
      type,
      agentId,
    });
  },
  {
    sessionAuth: true,
    response: "task-v2-list-response",
    detail: {
      tags: ["Tasks V2"],
      summary: "获取任务列表",
      description:
        "分页返回当前用户在当前组织下的定时任务列表，支持按名称 keyword、类型 type 和 agentId 筛选。page/pageSize 默认 1/20。",
    },
  },
);

// ── POST /tasks/v2 ──
app.post(
  "/tasks/v2",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia handler 参数类型推断受限
  async ({ store, body, error }: any) => {
    const authCtx = store.authContext!;
    const payload = body as CreateTaskV2Request;
    const result = await createTaskV2(authCtx.userId, authCtx.organizationId, payload as unknown as CreateTaskV2Input);

    if (!result.success) {
      const err = result.error!;
      const status = err.code === "VALIDATION_ERROR" ? 400 : 500;
      return error(status, { success: false, error: { code: err.code, message: err.message } });
    }
    return result;
  },
  {
    sessionAuth: true,
    body: "create-task-v2-request",
    response: { 200: "task-v2-response", 400: WebErrSchema, 500: WebErrSchema },
    detail: {
      tags: ["Tasks V2"],
      summary: "创建任务",
      description: "创建一个 HTTP 或 Agent 类型的定时任务。",
    },
  },
);

// ── GET /tasks/v2/:id ──
app.get(
  "/tasks/v2/:id",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia handler 参数类型推断受限
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext!;
    return safeTaskOp(async () => {
      const result = await getTaskV2(authCtx.userId, authCtx.organizationId, params.id);
      if (!result.success)
        return error(404, { success: false, error: { code: "not_found", message: result.error!.message } });
      return result;
    }, error);
  },
  {
    sessionAuth: true,
    response: { 200: "task-v2-response", 404: WebErrSchema },
    detail: { tags: ["Tasks V2"], summary: "获取任务详情" },
  },
);

// ── PUT /tasks/v2/:id ──
app.put(
  "/tasks/v2/:id",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia handler 参数类型推断受限
  async ({ store, params, body, error }: any) => {
    const authCtx = store.authContext!;
    const payload = body as UpdateTaskV2Request;
    return safeTaskOp(async () => {
      const result = await updateTaskV2(
        authCtx.userId,
        authCtx.organizationId,
        params.id,
        payload as unknown as Record<string, unknown>,
      );
      if (!result.success) {
        const err = result.error!;
        if (err.code === "NOT_FOUND")
          return error(404, { success: false, error: { code: "not_found", message: err.message } });
        return error(400, { success: false, error: { code: "validation_error", message: err.message } });
      }
      return result;
    }, error);
  },
  {
    sessionAuth: true,
    body: "update-task-v2-request",
    response: { 200: "task-v2-response", 400: WebErrSchema, 404: WebErrSchema },
    detail: {
      tags: ["Tasks V2"],
      summary: "更新任务",
      description: "更新任务配置；cron/时区/启用状态变化时重新调度。注意：type 不可修改。",
    },
  },
);

// ── DELETE /tasks/v2/:id ──
app.delete(
  "/tasks/v2/:id",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia handler 参数类型推断受限
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext!;
    try {
      const result = await deleteTaskV2(authCtx.userId, authCtx.organizationId, params.id);
      if (!result.success)
        return error(404, { success: false, error: { code: "not_found", message: result.error!.message } });
      return { success: true, data: null };
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
    response: { 200: "delete-v2-response", 404: WebErrSchema },
    detail: { tags: ["Tasks V2"], summary: "删除任务" },
  },
);

// ── POST /tasks/v2/:id/toggle ──
app.post(
  "/tasks/v2/:id/toggle",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia handler 参数类型推断受限
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext!;
    return safeTaskOp(async () => {
      const result = await toggleTaskV2(authCtx.userId, authCtx.organizationId, params.id);
      if (!result.success)
        return error(404, { success: false, error: { code: "not_found", message: result.error!.message } });
      return result;
    }, error);
  },
  {
    sessionAuth: true,
    response: { 200: "toggle-v2-response", 404: WebErrSchema },
    detail: { tags: ["Tasks V2"], summary: "切换任务启用状态" },
  },
);

// ── POST /tasks/v2/:id/trigger ──
app.post(
  "/tasks/v2/:id/trigger",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia handler 参数类型推断受限
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext!;
    return safeTaskOp(async () => {
      const result = await triggerTaskV2(authCtx.userId, authCtx.organizationId, params.id);
      if (!result.success)
        return error(404, { success: false, error: { code: "not_found", message: result.error!.message } });
      return result;
    }, error);
  },
  {
    sessionAuth: true,
    response: { 200: "trigger-v2-response", 404: WebErrSchema },
    detail: { tags: ["Tasks V2"], summary: "手动触发任务" },
  },
);

// ── GET /tasks/v2/:id/logs ──
app.get(
  "/tasks/v2/:id/logs",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia handler 参数类型推断受限
  async ({ store, params, query, error }: any) => {
    const authCtx = store.authContext!;
    return safeTaskOp(async () => {
      const taskResult = await getTaskV2(authCtx.userId, authCtx.organizationId, params.id);
      if (!taskResult.success)
        return error(404, { success: false, error: { code: "not_found", message: "任务不存在" } });

      const q = query as Record<string, string | undefined>;
      const page = Math.max(1, Number(q.page) || 1);
      const pageSize = Math.min(100, Math.max(1, Number(q.pageSize) || 20));
      return await listExecutionLogsV2(params.id, page, pageSize);
    }, error);
  },
  {
    sessionAuth: true,
    response: { 200: "task-v2-logs-response", 404: WebErrSchema },
    detail: { tags: ["Tasks V2"], summary: "获取执行日志" },
  },
);

// ── DELETE /tasks/v2/:id/logs ──
app.delete(
  "/tasks/v2/:id/logs",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia handler 参数类型推断受限
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext!;
    return safeTaskOp(async () => {
      const taskResult = await getTaskV2(authCtx.userId, authCtx.organizationId, params.id);
      if (!taskResult.success)
        return error(404, { success: false, error: { code: "not_found", message: "任务不存在" } });
      const result = await clearExecutionLogsV2(authCtx.userId, authCtx.organizationId, params.id);
      if (!result.success) return error(404, { success: false, error: { code: "not_found", message: "任务不存在" } });
      return { success: true, data: null };
    }, error);
  },
  {
    sessionAuth: true,
    response: { 200: "clear-task-v2-logs-response", 404: WebErrSchema },
    detail: { tags: ["Tasks V2"], summary: "清空任务日志" },
  },
);

export default app;
