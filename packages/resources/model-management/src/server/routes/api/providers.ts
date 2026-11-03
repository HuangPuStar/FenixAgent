import { ApiV1ErrSchema, ApiV1OkSchema, AppError, NotFoundError } from "@fenix/platform-sdk";
import Elysia from "elysia";
import * as z from "zod/v4";
import { getModelManagementModule } from "../../module-runtime";
import {
  ApiModelListQuerySchema,
  ApiProviderDetailSchema,
  ApiProviderIdParamsSchema,
  ApiProviderListResponseSchema,
  ApiProviderUpdateBodySchema,
  ApiProviderUpsertBodySchema,
} from "../../schemas/api-model.schema";
import {
  apiProviderActor,
  apiProviderDetail,
  apiProviderListItem,
  apiProviderWrite,
} from "../../services/api-v1-provider";
import type { ApiModelManagementRouteDependencies } from "../dependencies";

/** Provider v1 adapter; authorization and writes remain with the resource owner. */
export function createApiProvidersRoutes(deps: ApiModelManagementRouteDependencies) {
  return new Elysia({ name: "api-v1-providers", prefix: "/api/v1/providers" })
    .use(deps.authGuardPlugin)
    .onError(({ error, set }) => {
      if (error instanceof AppError) {
        set.status = error.statusCode;
        return {
          success: false as const,
          error: { code: error.code, message: error.statusCode >= 500 ? "Internal server error" : error.message },
        };
      }
    })
    .get(
      "",
      async ({ store, query }) => {
        const { page, pageSize } = query;
        const result = await getModelManagementModule().facade.list(apiProviderActor(store), {
          limit: pageSize,
          offset: (page - 1) * pageSize,
        });
        return {
          success: true as const,
          data: { items: result.items.map(apiProviderListItem), total: result.total, page, pageSize },
        };
      },
      {
        sessionAuth: true,
        query: ApiModelListQuerySchema,
        response: { 200: ApiV1OkSchema(ApiProviderListResponseSchema), 401: ApiV1ErrSchema },
        detail: { tags: ["External Model"], summary: "获取 Provider 列表" },
      },
    )
    .get(
      "/:providerId",
      async ({ store, params }) => {
        const row = await getModelManagementModule().facade.getById(apiProviderActor(store), params.providerId);
        if (!row) throw new NotFoundError("Provider not found");
        return { success: true as const, data: apiProviderDetail(row) };
      },
      {
        sessionAuth: true,
        params: ApiProviderIdParamsSchema,
        response: { 200: ApiV1OkSchema(ApiProviderDetailSchema), 401: ApiV1ErrSchema, 404: ApiV1ErrSchema },
        detail: { tags: ["External Model"], summary: "获取 Provider 详情" },
      },
    )
    .post(
      "",
      async ({ store, body, set }) => {
        const row = await getModelManagementModule().facade.create(
          apiProviderActor(store),
          body.name,
          apiProviderWrite(body),
          { publicReadable: body.publicReadable },
        );
        set.status = 201;
        return { success: true as const, data: apiProviderDetail(row) };
      },
      {
        sessionAuth: true,
        body: ApiProviderUpsertBodySchema,
        response: { 201: ApiV1OkSchema(ApiProviderDetailSchema), 401: ApiV1ErrSchema, 409: ApiV1ErrSchema },
        detail: { tags: ["External Model"], summary: "创建 Provider" },
      },
    )
    .patch(
      "/:providerId",
      async ({ store, params, body }) => {
        const row = await getModelManagementModule().facade.saveById(
          apiProviderActor(store),
          params.providerId,
          apiProviderWrite(body),
          { publicReadable: body.publicReadable },
        );
        return { success: true as const, data: apiProviderDetail(row) };
      },
      {
        sessionAuth: true,
        params: ApiProviderIdParamsSchema,
        body: ApiProviderUpdateBodySchema,
        response: {
          200: ApiV1OkSchema(ApiProviderDetailSchema),
          401: ApiV1ErrSchema,
          403: ApiV1ErrSchema,
          404: ApiV1ErrSchema,
        },
        detail: { tags: ["External Model"], summary: "更新 Provider" },
      },
    )
    .delete(
      "/:providerId",
      async ({ store, params }) => {
        await getModelManagementModule().facade.remove(apiProviderActor(store), {
          by: "resourceId",
          value: params.providerId,
        });
        return { success: true as const, data: null };
      },
      {
        sessionAuth: true,
        params: ApiProviderIdParamsSchema,
        response: { 200: ApiV1OkSchema(z.null()), 401: ApiV1ErrSchema, 403: ApiV1ErrSchema, 404: ApiV1ErrSchema },
        detail: { tags: ["External Model"], summary: "删除 Provider" },
      },
    );
}
