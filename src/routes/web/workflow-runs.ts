/**
 * Workflow 运行记录查询路由。
 *
 * GET /web/workflow-runs — 分页查询运行历史，支持状态过滤和名称搜索。
 */
import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import { WorkflowRunsQuerySchema, WorkflowRunsResponseSchema } from "../../schemas";
import { createPgStorageAdapter } from "../../services/workflow/pg-storage-adapter";

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

    const storage = createPgStorageAdapter(authCtx.organizationId);
    const result = await storage.listRuns({ page, pageSize, status, q });

    return { success: true, data: { ...result, page, pageSize } };
  },
  {
    sessionAuth: true,
    detail: {
      summary: "获取运行记录列表",
      description: "分页查询工作流运行记录，支持按状态过滤和按工作流名称模糊搜索。",
      tags: ["workflow"],
      query: WorkflowRunsQuerySchema,
      response: WorkflowRunsResponseSchema,
    },
  },
);

export { app as workflowRunsRoutes };
