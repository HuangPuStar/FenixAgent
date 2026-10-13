import { WebErrSchema } from "@fenix/platform-sdk";
import { Elysia } from "elysia";
import { prodViewFacade } from "../../facades/prod-view-facade";
import { IdParamsSchema, OkResponseSchema } from "../../schemas/prod-view.schema";
import type { WebProdViewRouteDependencies } from "../dependencies";

/**
 * `/web/prod-views/*` — 发布视图的公开读取端点。
 *
 * 改为工厂：守卫必须与宿主的认证解析是同一份实例（Elysia 的 `macro` / `state` 是实例作用域的，
 * 父实例无法向已构造的子实例回填），因此由宿主注入 `authGuardPlugin`；插件名沿用迁移前的
 * `web-prod-views`，避免与同批装配的其它 `/web/prod-views` 路由发生 Elysia 静默去重。
 *
 * 端点路径保持相对形式：挂载前缀由宿主 `apps/server/src/routes/web/index.ts` 决定。
 *
 * 取数经 Facade：路由只把认证上下文与协议参数交出去，"以哪个组织、哪个用户去读"由 Facade 推导，
 * 路由不接触仓储也不解释归属。
 */
export function createWebProdViewsRoutes(deps: WebProdViewRouteDependencies) {
  const app = new Elysia({ name: "web-prod-views" }).use(deps.authGuardPlugin);

  app.get(
    "/prod-views/:id/load",
    async ({ store, params, status }) => {
      const actor = store.authContext!;
      const result = await prodViewFacade.load(actor, params.id);
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
        description:
          "前端视图页面调用，返回 agentConfigId + environmentId + instanceUid + modulesConfig。需要同组织认证且视图 enabled=true",
      },
    },
  );

  return app;
}
