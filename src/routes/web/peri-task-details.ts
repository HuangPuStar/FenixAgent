import Elysia from "elysia";
import { NotFoundError } from "../../errors";
import { authGuardPlugin } from "../../plugins/auth";
import { WebErrSchema } from "../../schemas/common.schema";
import {
  PeriTaskDetailParamsSchema,
  PeriTaskDetailQuerySchema,
  PeriTaskDetailResponseSchema,
} from "../../schemas/peri-task-details";
import { docManager } from "../../services/doc-manager-instance";
import { getOwnedEnvironment } from "../../services/environment";
import { getPeriTaskDetail } from "../../services/peri-task-detail-service";
import { createPeriTaskDetailStore } from "../../services/peri-task-detail-store";

const detailStore = createPeriTaskDetailStore(docManager);

const app = new Elysia({ name: "web-peri-task-details" }).use(authGuardPlugin).get(
  "/agents/:environmentId/sessions/:sessionId/peri-tasks/:taskId/detail",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
  async ({ store, params, query, error }: any) => {
    const authContext = store.authContext!;
    try {
      const data = await getPeriTaskDetail(
        {
          organizationId: authContext.organizationId,
          userId: store.user!.id,
          environmentId: params.environmentId,
          sessionId: params.sessionId,
          taskId: params.taskId,
        },
        query,
        { getOwnedEnvironment, store: detailStore },
      );
      return { success: true as const, data };
    } catch (err: unknown) {
      if (err instanceof NotFoundError) {
        return error(404, { success: false, error: { code: "NOT_FOUND", message: "任务详情不存在" } });
      }
      throw err;
    }
  },
  {
    sessionAuth: true,
    params: PeriTaskDetailParamsSchema,
    query: PeriTaskDetailQuerySchema,
    response: { 200: PeriTaskDetailResponseSchema, 404: WebErrSchema },
    detail: {
      tags: ["Peri Tasks"],
      summary: "按任务类型读取 Peri Task 详情",
      description: "仅返回真实来源提供的有界摘要；不返回 locator，也不将摘要声明为完整 transcript。",
    },
  },
);

export default app;
