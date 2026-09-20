import { WebErrSchema } from "@fenix/platform-sdk";
import { Elysia } from "elysia";
import {
  CreateProdViewSchema,
  IdParamsSchema,
  ListProdViewQuerySchema,
  OkResponseSchema,
  UpdateProdViewSchema,
} from "../../../schemas/prod-view.schema";
import * as prodViewService from "../../../services/prod-view";
import type { WebProdViewRouteDependencies } from "../../dependencies";

/**
 * `/web/config/prod-views` — 发布视图的管理 CRUD（列表 / 详情 / 创建 / 更新 / 删除）。
 *
 * 改为工厂：守卫必须与宿主的认证解析是同一份实例（Elysia 的 `macro` / `state` 是实例作用域的，
 * 父实例无法向已构造的子实例回填），因此由宿主注入 `authGuardPlugin`；插件名沿用迁移前的
 * `web-config-prod-views`，避免与 `/web/config/*` 下同批装配的路由静默去重。
 *
 * 端点路径保持相对形式（`/config/prod-views...`）：挂载前缀由宿主
 * `apps/server/src/routes/web/config/index.ts` 决定，本包不自造前缀。
 */
export function createWebConfigProdViewsRoutes(deps: WebProdViewRouteDependencies) {
  const app = new Elysia({ name: "web-config-prod-views" }).use(deps.authGuardPlugin);

  // GET /config/prod-views — 列表
  app.get(
    "/config/prod-views",
    async ({ store, query }) => {
      const actor = store.authContext!;
      return prodViewService.listProdViews(actor, query);
    },
    {
      sessionAuth: true,
      query: ListProdViewQuerySchema,
      response: { 200: OkResponseSchema, 400: WebErrSchema },
      detail: {
        tags: ["ProdView"],
        summary: "获取 ProdView 列表",
        description: "获取当前组织的 ProdView 列表，可按 agentId 或 enabled 过滤",
      },
    },
  );

  // GET /config/prod-views/:id — 详情
  app.get(
    "/config/prod-views/:id",
    async ({ store, params }) => {
      const actor = store.authContext!;
      return prodViewService.getProdView(actor, params.id);
    },
    {
      sessionAuth: true,
      params: IdParamsSchema,
      response: { 200: OkResponseSchema, 404: WebErrSchema },
      detail: { tags: ["ProdView"], summary: "获取单个 ProdView 详情" },
    },
  );

  // POST /config/prod-views — 创建
  app.post(
    "/config/prod-views",
    async ({ store, body }) => {
      const actor = store.authContext!;
      return prodViewService.createProdView(actor, body);
    },
    {
      sessionAuth: true,
      body: CreateProdViewSchema,
      response: { 200: OkResponseSchema, 400: WebErrSchema },
      detail: { tags: ["ProdView"], summary: "创建 ProdView" },
    },
  );

  // PUT /config/prod-views/:id — 更新
  app.put(
    "/config/prod-views/:id",
    async ({ store, params, body, status }) => {
      const actor = store.authContext!;
      const result = await prodViewService.updateProdView(actor, params.id, body);
      if (!result.success) return status(404, { success: false as const, error: result.error });
      return result;
    },
    {
      sessionAuth: true,
      params: IdParamsSchema,
      body: UpdateProdViewSchema,
      response: { 200: OkResponseSchema, 400: WebErrSchema, 404: WebErrSchema },
      detail: { tags: ["ProdView"], summary: "更新 ProdView 配置" },
    },
  );

  // DELETE /config/prod-views/:id — 删除
  app.delete(
    "/config/prod-views/:id",
    async ({ store, params, status }) => {
      const actor = store.authContext!;
      const result = await prodViewService.deleteProdView(actor, params.id);
      if (!result.success) return status(404, { success: false as const, error: result.error });
      return result;
    },
    {
      sessionAuth: true,
      params: IdParamsSchema,
      response: { 200: OkResponseSchema, 404: WebErrSchema },
      detail: { tags: ["ProdView"], summary: "删除 ProdView" },
    },
  );

  return app;
}
