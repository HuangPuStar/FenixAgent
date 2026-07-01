/**
 * Workflow 运行记录查询路由。
 *
 * GET /web/workflow-runs — 分页查询运行历史，支持状态过滤和名称搜索。
 */
import { createLogger } from "@fenix/logger";
import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import { WorkflowRunsQuerySchema, WorkflowRunsResponseSchema, WorkflowRunsRouteQuerySchema } from "../../schemas";
import { WebErrSchema } from "../../schemas/common.schema";
import { createPgStorageAdapter } from "../../services/workflow/pg-storage-adapter";

const logger = createLogger("wf-runs");

const app = new Elysia({ name: "web-workflow-runs" }).use(authGuardPlugin);

// GET /web/workflow-runs — 分页查询运行记录
app.get(
  "/workflow-runs",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
  async ({ store, query, error }: any) => {
    const authCtx = store.authContext!;
    const parsed = WorkflowRunsQuerySchema.safeParse(query);
    if (!parsed.success) {
      return error(400, { success: false, error: { code: "INVALID_PARAMS", message: parsed.error.message } });
    }
    const { page, pageSize, status, q } = parsed.data;

    try {
      const storage = createPgStorageAdapter(authCtx.organizationId);
      const result = await storage.listRuns({ page, pageSize, status, q });
      return { success: true, data: { ...result, page, pageSize } };
    } catch (err) {
      // 数据库连接或其他运行时异常：不泄露内部堆栈给客户端
      logger.error("listRuns failed:", err);
      return error(500, {
        success: false,
        error: { code: "INTERNAL_ERROR", message: "Failed to list workflow runs" },
      });
    }
  },
  {
    sessionAuth: true,
    query: WorkflowRunsRouteQuerySchema,
    response: {
      200: WorkflowRunsResponseSchema,
      400: WebErrSchema,
      500: WebErrSchema,
    },
    detail: {
      summary: "获取运行记录列表",
      description: "分页查询工作流运行记录，支持按状态过滤和按工作流名称模糊搜索。",
      tags: ["Workflow Engine"],
    },
  },
);

export { app as workflowRunsRoutes };
