import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import { WebErrSchema } from "../../schemas/common.schema";
import { IdParamsSchema, OkResponseSchema } from "../../schemas/prod-view.schema";
import { loadProdView } from "../../services/prod-view";

const app = new Elysia({ name: "web-prod-views" }).use(authGuardPlugin);

app.get(
  "/prod-views/:id/load",
  async ({ store, params, status }) => {
    const ctx = store.authContext!;
    const result = await loadProdView(ctx, params.id);
    if (!result.success) return status(404, { success: false as const, error: result.error });
    return result;
  },
  {
    sessionAuth: true,
    params: IdParamsSchema,
    response: { 200: OkResponseSchema, 404: WebErrSchema },
    detail: {
      tags: ["ProdView"],
      summary: "加载 ProdView 视图数据",
      description: "前端视图页面调用，返回 agentId + modulesConfig。需要同组织认证且视图 enabled=true",
    },
  },
);

export default app;
