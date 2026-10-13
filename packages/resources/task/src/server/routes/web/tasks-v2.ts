import { WebErrSchema } from "@fenix/platform-sdk";
import Elysia from "elysia";
import { taskV2Facade } from "../../facades/task-v2-facade";
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
import type { CreateTaskV2Input, UpdateTaskV2Input } from "../../services/task-v2";
import type { WebTaskRouteDependencies } from "../dependencies";

/**
 * `/web/tasks/v2` 控制台路由工厂。
 *
 * 从宿主的实例导出改为工厂：守卫必须与宿主的认证解析是同一份实例（Elysia 的 `macro` / `state` 是实例
 * 作用域的，父实例无法向已构造的子实例回填），因此由宿主注入 `authGuardPlugin`；宿主调用点
 * `apps/server/src/routes/web/index.ts:17,52,79`（取工厂 / 注入守卫 / 挂载）已按该形态接线。
 *
 * 取数经 Facade（`../../facades/task-v2-facade`）：路由只把宿主的认证上下文与协议已校验的数据交出去，
 * 归属范围（`user_id` + `organization_id`）由门面从 actor 推导；本层保留的只有协议映射——查询串解析、
 * `NOT_FOUND` → 404 / `VALIDATION_ERROR` → 400 的状态码映射，以及无效 UUID 的 SQL 错误兜底。
 */
export function createWebTasksV2Routes(deps: WebTaskRouteDependencies) {
  const app = new Elysia({ name: "web-tasks-v2" }).use(deps.authGuardPlugin).model({
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
      const actor = store.authContext!;
      const q = query as Record<string, string | undefined>;
      const page = Number(q.page) || 1;
      const pageSize = Number(q.pageSize) || 20;
      const keyword = q.keyword || undefined;
      const type = q.type || undefined;
      const agentId = q.agentId || undefined;
      return {
        success: true as const,
        data: await taskV2Facade.list(actor, page, pageSize, { keyword, type, agentId }),
      };
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
      const actor = store.authContext!;
      const payload = body as CreateTaskV2Request;
      const result = await taskV2Facade.create(actor, payload as unknown as CreateTaskV2Input);

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
      const actor = store.authContext!;
      return safeTaskOp(async () => {
        const result = await taskV2Facade.get(actor, params.id);
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
      const actor = store.authContext!;
      const payload = body as UpdateTaskV2Request;
      return safeTaskOp(async () => {
        const result = await taskV2Facade.update(actor, params.id, payload as unknown as UpdateTaskV2Input);
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
      const actor = store.authContext!;
      try {
        const result = await taskV2Facade.remove(actor, params.id);
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
      const actor = store.authContext!;
      return safeTaskOp(async () => {
        const result = await taskV2Facade.toggle(actor, params.id);
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
      const actor = store.authContext!;
      return safeTaskOp(async () => {
        const result = await taskV2Facade.trigger(actor, params.id);
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
      const actor = store.authContext!;
      return safeTaskOp(async () => {
        const q = query as Record<string, string | undefined>;
        const page = Math.max(1, Number(q.page) || 1);
        const pageSize = Math.min(100, Math.max(1, Number(q.pageSize) || 20));
        // 归属确认在门面内完成：日志没有独立归属列，可读性由所属任务决定。
        const logs = await taskV2Facade.listLogs(actor, params.id, page, pageSize);
        if (!logs.success)
          return error(404, { success: false, error: { code: "not_found", message: logs.error.message } });
        return logs;
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
      const actor = store.authContext!;
      return safeTaskOp(async () => {
        const result = await taskV2Facade.clearLogs(actor, params.id);
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

  return app;
}
