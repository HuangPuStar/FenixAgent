import Elysia from "elysia";
import { authGuardPlugin } from "../../../plugins/auth";
import { WebErrSchema } from "../../../schemas/common.schema";
import {
  CreateProdViewSchema,
  IdParamsSchema,
  ListProdViewQuerySchema,
  OkResponseSchema,
  UpdateProdViewSchema,
} from "../../../schemas/prod-view.schema";
import * as prodViewService from "../../../services/prod-view";

const app = new Elysia({ name: "web-config-prod-views" }).use(authGuardPlugin);

// GET /config/prod-views — 列表
app.get(
  "/config/prod-views",
  async ({ store, query }) => {
    const ctx = store.authContext!;
    return prodViewService.listProdViews(ctx, query);
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
    const ctx = store.authContext!;
    return prodViewService.getProdView(ctx, params.id);
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
    const ctx = store.authContext!;
    return prodViewService.createProdView(ctx, body);
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
    const ctx = store.authContext!;
    const result = await prodViewService.updateProdView(ctx, params.id, body);
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
    const ctx = store.authContext!;
    const result = await prodViewService.deleteProdView(ctx, params.id);
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

export default app;
