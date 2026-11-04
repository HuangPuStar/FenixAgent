import { ApiV1ErrSchema, ApiV1OkSchema, AppError, NotFoundError } from "@fenix/platform-sdk";
import Elysia from "elysia";
import * as z from "zod/v4";
import { getModelManagementModule } from "../../module-runtime";
import {
  ApiModelDetailSchema,
  ApiModelIdParamsSchema,
  ApiModelListQuerySchema,
  ApiModelListResponseSchema,
  ApiModelUpdateBodySchema,
  ApiModelUpsertBodySchema,
  ApiProviderOnlyParamsSchema,
} from "../../schemas/api-model.schema";
import { apiModelDetail, apiProviderActor } from "../../services/api-v1-provider";
import { modelWriteDataFromApi } from "../../services/model-write-data";
import type { ApiModelManagementRouteDependencies } from "../dependencies";
import { createApiProvidersRoutes } from "./providers";

/** Provider/Model route contribution for the versioned external protocol. */
export function createApiModelsRoutes(deps: ApiModelManagementRouteDependencies) {
  const models = new Elysia({ name: "api-v1-models", prefix: "/api/v1/providers/:providerId/models" })
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
      async ({ store, params, query }) => {
        const { page, pageSize } = query;
        const result = await getModelManagementModule().facade.listModels(
          apiProviderActor(store),
          { by: "resourceId", value: params.providerId },
          { limit: pageSize, offset: (page - 1) * pageSize },
        );
        if (!result) throw new NotFoundError("Provider not found");
        return {
          success: true as const,
          data: { items: result.items.map(apiModelDetail), total: result.total, page, pageSize },
        };
      },
      {
        sessionAuth: true,
        params: ApiProviderOnlyParamsSchema,
        query: ApiModelListQuerySchema,
        response: { 200: ApiV1OkSchema(ApiModelListResponseSchema), 401: ApiV1ErrSchema, 404: ApiV1ErrSchema },
        detail: { tags: ["External Model"], summary: "获取 Model 列表" },
      },
    )
    .get(
      "/:id",
      async ({ store, params }) => {
        const row = await getModelManagementModule().facade.getById(apiProviderActor(store), params.providerId);
        const model = row?.models.find((item) => item.id === params.id);
        if (!model) throw new NotFoundError("Model not found");
        return { success: true as const, data: apiModelDetail(model) };
      },
      {
        sessionAuth: true,
        params: ApiModelIdParamsSchema,
        response: { 200: ApiV1OkSchema(ApiModelDetailSchema), 401: ApiV1ErrSchema, 404: ApiV1ErrSchema },
        detail: { tags: ["External Model"], summary: "获取 Model 详情" },
      },
    )
    .post(
      "",
      async ({ store, params, body, set }) => {
        const result = await getModelManagementModule().facade.createModel(
          apiProviderActor(store),
          { by: "resourceId", value: params.providerId },
          body.modelId,
          modelWriteDataFromApi(body),
        );
        const model = result.provider.models.find((item) => item.id === result.id);
        if (!model) throw new Error("Created model could not be reloaded");
        set.status = 201;
        return { success: true as const, data: apiModelDetail(model) };
      },
      {
        sessionAuth: true,
        params: ApiProviderOnlyParamsSchema,
        body: ApiModelUpsertBodySchema,
        response: {
          201: ApiV1OkSchema(ApiModelDetailSchema),
          401: ApiV1ErrSchema,
          403: ApiV1ErrSchema,
          404: ApiV1ErrSchema,
          409: ApiV1ErrSchema,
        },
        detail: { tags: ["External Model"], summary: "创建 Model" },
      },
    )
    .patch(
      "/:id",
      async ({ store, params, body }) => {
        const result = await getModelManagementModule().facade.updateModel(
          apiProviderActor(store),
          { by: "resourceId", value: params.providerId },
          { by: "id", value: params.id },
          modelWriteDataFromApi(body),
        );
        const model = result.provider.models.find((item) => item.id === params.id);
        if (!model) throw new Error("Updated model could not be reloaded");
        return { success: true as const, data: apiModelDetail(model) };
      },
      {
        sessionAuth: true,
        params: ApiModelIdParamsSchema,
        body: ApiModelUpdateBodySchema,
        response: {
          200: ApiV1OkSchema(ApiModelDetailSchema),
          401: ApiV1ErrSchema,
          403: ApiV1ErrSchema,
          404: ApiV1ErrSchema,
        },
        detail: { tags: ["External Model"], summary: "更新 Model" },
      },
    )
    .delete(
      "/:id",
      async ({ store, params }) => {
        await getModelManagementModule().facade.removeModel(
          apiProviderActor(store),
          { by: "resourceId", value: params.providerId },
          { by: "id", value: params.id },
        );
        return { success: true as const, data: null };
      },
      {
        sessionAuth: true,
        params: ApiModelIdParamsSchema,
        response: { 200: ApiV1OkSchema(z.null()), 401: ApiV1ErrSchema, 403: ApiV1ErrSchema, 404: ApiV1ErrSchema },
        detail: { tags: ["External Model"], summary: "删除 Model" },
      },
    );
  return new Elysia({ name: "api-models" }).use(createApiProvidersRoutes(deps)).use(models);
}
