import Elysia from "elysia";
import { AppError } from "../../errors";
import { type AuthContext, authGuardPlugin } from "../../plugins/auth";
import { ApiErrorResponseSchema } from "../../schemas/api-common.schema";
import {
  ApiModelDeleteResponseSchema,
  ApiModelDetailSchema,
  ApiModelIdParamsSchema,
  type ApiModelListQuery,
  ApiModelListQuerySchema,
  ApiModelListResponseSchema,
  type ApiModelUpdateBody,
  ApiModelUpdateBodySchema,
  type ApiModelUpsertBody,
  ApiModelUpsertBodySchema,
  ApiProviderDeleteResponseSchema,
  ApiProviderDetailSchema,
  ApiProviderIdParamsSchema,
  ApiProviderListResponseSchema,
  ApiProviderOnlyParamsSchema,
  type ApiProviderUpdateBody,
  ApiProviderUpdateBodySchema,
  type ApiProviderUpsertBody,
  ApiProviderUpsertBodySchema,
} from "../../schemas/api-model.schema";
import * as configPg from "../../services/config/index";
import { buildModelData } from "../../services/config/provider";

/**
 * 将业务异常映射到对外 API 的稳定错误结构。
 */
function mapApiError(error: unknown): { status: number; body: { error: { code: string; message: string } } } {
  if (error instanceof AppError) {
    return { status: error.statusCode, body: { error: { code: error.code, message: error.message } } };
  }
  return {
    status: 500,
    body: { error: { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : "Unknown error" } },
  };
}

/**
 * 组装对外 Provider 列表项，避免把内部字段和敏感细节直接暴露给列表接口。
 */
function toProviderListItem(provider: Awaited<ReturnType<typeof configPg.listProviders>>[number]) {
  return {
    id: provider.id,
    name: provider.name,
    displayName: provider.displayName ?? null,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl ?? null,
    modelCount: provider.modelCount ?? 0,
    resourceAccess: provider.resourceAccess,
  };
}

/**
 * 组装对外 Provider 详情。
 */
function toProviderDetail(detail: NonNullable<Awaited<ReturnType<typeof configPg.getProvider>>>) {
  return {
    id: detail.id,
    name: detail.name,
    displayName: detail.displayName ?? null,
    protocol: detail.protocol,
    baseUrl: detail.baseUrl ?? null,
    extraOptions: detail.extraOptions ?? null,
    models: (detail.models ?? []).map((model) => ({
      providerId: detail.id,
      id: model.id,
      modelId: model.modelId,
      displayName: model.displayName ?? null,
      modalities: model.modalities ?? null,
      limitConfig: model.limitConfig ?? null,
      cost: model.cost ?? null,
    })),
    resourceAccess: detail.resourceAccess,
  };
}

/**
 * 组装对外 Model 详情。
 */
function toModelDetail(
  providerId: string,
  providerName: string,
  detail: {
    id: string;
    modelId: string;
    displayName: string | null;
    modalities: unknown;
    limitConfig: unknown;
    cost: unknown;
    options: unknown;
  },
) {
  return {
    providerId,
    id: detail.id,
    modelId: detail.modelId,
    providerName,
    displayName: detail.displayName ?? null,
    modalities: detail.modalities ?? null,
    limitConfig: detail.limitConfig ?? null,
    cost: detail.cost ?? null,
    options:
      detail.options && typeof detail.options === "object" && !Array.isArray(detail.options)
        ? (detail.options as Record<string, unknown>)
        : null,
  };
}

/**
 * 将对外 API 的字段命名转换为内部 config 服务需要的结构。
 * 对外使用 displayName / limitConfig，内部仍沿用 name / limit。
 */
function toModelWriteData(body: ApiModelUpsertBody | ApiModelUpdateBody) {
  return buildModelData({
    name: body.displayName ?? undefined,
    modalities: body.modalities,
    limit: body.limitConfig,
    cost: body.cost,
    options: body.options,
  });
}

const app = new Elysia({ name: "api-models", prefix: "/api/models" }).use(authGuardPlugin).model({
  "api-model-list-query": ApiModelListQuerySchema,
  "api-provider-id-params": ApiProviderIdParamsSchema,
  "api-model-id-params": ApiModelIdParamsSchema,
  "api-provider-only-params": ApiProviderOnlyParamsSchema,
  "api-provider-create-body": ApiProviderUpsertBodySchema,
  "api-provider-update-body": ApiProviderUpdateBodySchema,
  "api-model-create-body": ApiModelUpsertBodySchema,
  "api-model-update-body": ApiModelUpdateBodySchema,
  "api-provider-list-response": ApiProviderListResponseSchema,
  "api-provider-detail": ApiProviderDetailSchema,
  "api-provider-delete-response": ApiProviderDeleteResponseSchema,
  "api-model-list-response": ApiModelListResponseSchema,
  "api-model-detail": ApiModelDetailSchema,
  "api-model-delete-response": ApiModelDeleteResponseSchema,
});

// ── Provider CRUD ────────────────────────────────────────────

app.get(
  "/providers",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在自定义 response schema 下类型推断不稳定
  async ({ store, query, error }: any) => {
    const authCtx = store.authContext as AuthContext;
    const { page, pageSize } = query as ApiModelListQuery;

    try {
      const providers = await configPg.listProviders(authCtx);
      const total = providers.length;
      const start = (page - 1) * pageSize;
      const items = providers.slice(start, start + pageSize).map((provider) => toProviderListItem(provider));
      return { items, total, page, pageSize };
    } catch (err) {
      const mapped = mapApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  {
    sessionAuth: true,
    query: "api-model-list-query",
    response: {
      200: "api-provider-list-response",
      400: ApiErrorResponseSchema,
      401: ApiErrorResponseSchema,
      500: ApiErrorResponseSchema,
    },
    detail: {
      tags: ["External Model"],
      summary: "获取 Provider 列表",
      description: "返回当前组织可见的 Provider 列表，采用稳定分页结构。",
    },
  },
);

app.post(
  "/providers",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在自定义 response schema 下类型推断不稳定
  async ({ store, body, error }: any) => {
    const authCtx = store.authContext as AuthContext;
    const payload = body as ApiProviderUpsertBody;

    try {
      const existing = await configPg.getProvider(authCtx, payload.name);
      if (existing) {
        return error(409, { error: { code: "CONFLICT", message: `Provider '${payload.name}' already exists` } });
      }

      await configPg.upsertProvider(
        authCtx,
        payload.name,
        {
          displayName: payload.displayName ?? undefined,
          protocol: payload.protocol,
          baseUrl: payload.baseUrl ?? undefined,
          apiKey: payload.apiKey ?? undefined,
          extraOptions: payload.extraOptions ?? undefined,
        },
        { publicReadable: payload.publicReadable },
      );

      const detail = await configPg.getProvider(authCtx, payload.name);
      if (!detail) {
        return error(500, { error: { code: "INTERNAL_ERROR", message: "Provider could not be reloaded" } });
      }
      return toProviderDetail(detail);
    } catch (err) {
      const mapped = mapApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  {
    sessionAuth: true,
    body: "api-provider-create-body",
    response: {
      200: "api-provider-detail",
      400: ApiErrorResponseSchema,
      401: ApiErrorResponseSchema,
      409: ApiErrorResponseSchema,
      500: ApiErrorResponseSchema,
    },
    detail: {
      tags: ["External Model"],
      summary: "创建 Provider",
      description: "创建一个新的 Provider 配置。名称已存在时返回冲突错误。",
    },
  },
);

app.get(
  "/providers/:providerId",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在自定义 response schema 下类型推断不稳定
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext as AuthContext;
    const { providerId } = params as { providerId: string };

    try {
      const detail = await configPg.getProviderById(authCtx, providerId);
      if (!detail) {
        return error(404, { error: { code: "NOT_FOUND", message: `Provider '${providerId}' not found` } });
      }
      return toProviderDetail(detail);
    } catch (err) {
      const mapped = mapApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  {
    sessionAuth: true,
    params: "api-provider-id-params",
    response: {
      200: "api-provider-detail",
      401: ApiErrorResponseSchema,
      404: ApiErrorResponseSchema,
      500: ApiErrorResponseSchema,
    },
    detail: {
      tags: ["External Model"],
      summary: "获取 Provider 详情",
      description: "按 Provider 唯一 ID 返回配置详情以及其下的模型摘要。",
    },
  },
);

app.put(
  "/providers/:providerId",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在自定义 response schema 下类型推断不稳定
  async ({ store, params, body, error }: any) => {
    const authCtx = store.authContext as AuthContext;
    const { providerId } = params as { providerId: string };
    const payload = body as ApiProviderUpdateBody;

    try {
      const existing = await configPg.assertProviderInternalWritableById(authCtx, providerId);
      if (!existing) {
        return error(404, { error: { code: "NOT_FOUND", message: `Provider '${providerId}' not found` } });
      }

      const updated = await configPg.updateProviderById(
        authCtx,
        providerId,
        {
          displayName: payload.displayName,
          protocol: payload.protocol,
          baseUrl: payload.baseUrl,
          apiKey: payload.apiKey,
          extraOptions: payload.extraOptions,
        },
        { publicReadable: payload.publicReadable },
      );
      if (!updated) {
        return error(404, { error: { code: "NOT_FOUND", message: `Provider '${providerId}' not found` } });
      }

      const detail = await configPg.getProviderById(authCtx, providerId);
      if (!detail) {
        return error(500, { error: { code: "INTERNAL_ERROR", message: "Provider could not be reloaded" } });
      }
      return toProviderDetail(detail);
    } catch (err) {
      const mapped = mapApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  {
    sessionAuth: true,
    params: "api-provider-id-params",
    body: "api-provider-update-body",
    response: {
      200: "api-provider-detail",
      400: ApiErrorResponseSchema,
      401: ApiErrorResponseSchema,
      404: ApiErrorResponseSchema,
      500: ApiErrorResponseSchema,
    },
    detail: {
      tags: ["External Model"],
      summary: "更新 Provider",
      description: "更新指定 Provider 的基础配置与共享访问设置。",
    },
  },
);

app.delete(
  "/providers/:providerId",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在自定义 response schema 下类型推断不稳定
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext as AuthContext;
    const { providerId } = params as { providerId: string };

    try {
      const deleted = await configPg.deleteProviderById(authCtx, providerId);
      if (!deleted) {
        return error(404, { error: { code: "NOT_FOUND", message: `Provider '${providerId}' not found` } });
      }
      return { id: providerId, deleted: true as const };
    } catch (err) {
      const mapped = mapApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  {
    sessionAuth: true,
    params: "api-provider-id-params",
    response: {
      200: "api-provider-delete-response",
      401: ApiErrorResponseSchema,
      404: ApiErrorResponseSchema,
      500: ApiErrorResponseSchema,
    },
    detail: {
      tags: ["External Model"],
      summary: "删除 Provider",
      description: "删除指定 Provider 及其关联的模型配置。",
    },
  },
);

// ── Model CRUD ───────────────────────────────────────────────

app.post(
  "/providers/:providerId/models",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在自定义 response schema 下类型推断不稳定
  async ({ store, params, body, error }: any) => {
    const authCtx = store.authContext as AuthContext;
    const { providerId } = params as { providerId: string };
    const payload = body as ApiModelUpsertBody;

    try {
      const provider = await configPg.assertProviderInternalWritableById(authCtx, providerId);
      if (!provider) {
        return error(404, { error: { code: "NOT_FOUND", message: `Provider '${providerId}' not found` } });
      }
      if ((provider.models ?? []).some((model) => model.modelId === payload.modelId)) {
        return error(409, { error: { code: "CONFLICT", message: `Model '${payload.modelId}' already exists` } });
      }

      const createdId = await configPg.addModel(authCtx, provider.id, {
        modelId: payload.modelId,
        ...toModelWriteData(payload),
      });

      const detail = await configPg.getProviderById(authCtx, providerId);
      const modelDetail = detail?.models?.find((model) => model.id === createdId);
      if (!detail || !modelDetail) {
        return error(500, { error: { code: "INTERNAL_ERROR", message: "Model could not be reloaded" } });
      }
      return toModelDetail(detail.id, detail.name, modelDetail);
    } catch (err) {
      const mapped = mapApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  {
    sessionAuth: true,
    params: "api-provider-only-params",
    body: "api-model-create-body",
    response: {
      200: "api-model-detail",
      400: ApiErrorResponseSchema,
      401: ApiErrorResponseSchema,
      404: ApiErrorResponseSchema,
      409: ApiErrorResponseSchema,
      500: ApiErrorResponseSchema,
    },
    detail: {
      tags: ["External Model"],
      summary: "创建 Model",
      description: "向指定 Provider ID 对应的 Provider 添加一个新的 Model 配置。",
    },
  },
);

app.get(
  "/providers/:providerId/models",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在自定义 response schema 下类型推断不稳定
  async ({ store, params, query, error }: any) => {
    const authCtx = store.authContext as AuthContext;
    const { providerId } = params as { providerId: string };
    const { page, pageSize } = query as ApiModelListQuery;

    try {
      const detail = await configPg.getProviderById(authCtx, providerId);
      if (!detail) {
        return error(404, { error: { code: "NOT_FOUND", message: `Provider '${providerId}' not found` } });
      }

      const models = (detail.models ?? []).map((model) => ({
        providerId: detail.id,
        id: model.id,
        modelId: model.modelId,
        providerName: detail.name,
        displayName: model.displayName ?? null,
        modalities: model.modalities ?? null,
        limitConfig: model.limitConfig ?? null,
        cost: model.cost ?? null,
      }));
      const total = models.length;
      const start = (page - 1) * pageSize;
      const items = models.slice(start, start + pageSize);
      return { items, total, page, pageSize };
    } catch (err) {
      const mapped = mapApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  {
    sessionAuth: true,
    params: "api-provider-only-params",
    query: "api-model-list-query",
    response: {
      200: "api-model-list-response",
      400: ApiErrorResponseSchema,
      401: ApiErrorResponseSchema,
      404: ApiErrorResponseSchema,
      500: ApiErrorResponseSchema,
    },
    detail: {
      tags: ["External Model"],
      summary: "获取 Model 列表",
      description: "返回指定 Provider ID 对应 Provider 下的 Model 列表，采用稳定分页结构。",
    },
  },
);

app.get(
  "/providers/:providerId/models/:id",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在自定义 response schema 下类型推断不稳定
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext as AuthContext;
    const { providerId, id } = params as { providerId: string; id: string };

    try {
      const detail = await configPg.getProviderById(authCtx, providerId);
      if (!detail) {
        return error(404, { error: { code: "NOT_FOUND", message: `Provider '${providerId}' not found` } });
      }

      const modelDetail = detail.models?.find((model) => model.id === id);
      if (!modelDetail) {
        return error(404, { error: { code: "NOT_FOUND", message: `Model '${id}' not found` } });
      }
      return toModelDetail(detail.id, detail.name, modelDetail);
    } catch (err) {
      const mapped = mapApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  {
    sessionAuth: true,
    params: "api-model-id-params",
    response: {
      200: "api-model-detail",
      401: ApiErrorResponseSchema,
      404: ApiErrorResponseSchema,
      500: ApiErrorResponseSchema,
    },
    detail: {
      tags: ["External Model"],
      summary: "获取 Model 详情",
      description: "按 Provider 唯一 ID 和 Model 唯一 ID 返回 Model 配置详情。",
    },
  },
);

app.put(
  "/providers/:providerId/models/:id",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在自定义 response schema 下类型推断不稳定
  async ({ store, params, body, error }: any) => {
    const authCtx = store.authContext as AuthContext;
    const { providerId, id } = params as { providerId: string; id: string };
    const payload = body as ApiModelUpdateBody;

    try {
      const provider = await configPg.assertProviderInternalWritableById(authCtx, providerId);
      if (!provider) {
        return error(404, { error: { code: "NOT_FOUND", message: `Provider '${providerId}' not found` } });
      }

      const updated = await configPg.updateModelById(authCtx, provider.id, id, toModelWriteData(payload));
      if (!updated) {
        return error(404, { error: { code: "NOT_FOUND", message: `Model '${id}' not found` } });
      }

      const detail = await configPg.getProviderById(authCtx, providerId);
      const modelDetail = detail?.models?.find((model) => model.id === id);
      if (!detail || !modelDetail) {
        return error(500, { error: { code: "INTERNAL_ERROR", message: "Model could not be reloaded" } });
      }
      return toModelDetail(detail.id, detail.name, modelDetail);
    } catch (err) {
      const mapped = mapApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  {
    sessionAuth: true,
    params: "api-model-id-params",
    body: "api-model-update-body",
    response: {
      200: "api-model-detail",
      400: ApiErrorResponseSchema,
      401: ApiErrorResponseSchema,
      404: ApiErrorResponseSchema,
      500: ApiErrorResponseSchema,
    },
    detail: {
      tags: ["External Model"],
      summary: "更新 Model",
      description: "更新指定 Provider ID 下 Model 的展示名称、模态、限制和成本配置。",
    },
  },
);

app.delete(
  "/providers/:providerId/models/:id",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在自定义 response schema 下类型推断不稳定
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext as AuthContext;
    const { providerId, id } = params as { providerId: string; id: string };

    try {
      const provider = await configPg.assertProviderInternalWritableById(authCtx, providerId);
      if (!provider) {
        return error(404, { error: { code: "NOT_FOUND", message: `Provider '${providerId}' not found` } });
      }

      const existing = provider.models?.find((model) => model.id === id);
      if (!existing) {
        return error(404, { error: { code: "NOT_FOUND", message: `Model '${id}' not found` } });
      }

      const deleted = await configPg.removeModelById(authCtx, provider.id, id);
      if (!deleted) {
        return error(404, { error: { code: "NOT_FOUND", message: `Model '${id}' not found` } });
      }
      return { providerId, id, modelId: existing.modelId, deleted: true as const };
    } catch (err) {
      const mapped = mapApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  {
    sessionAuth: true,
    params: "api-model-id-params",
    response: {
      200: "api-model-delete-response",
      401: ApiErrorResponseSchema,
      404: ApiErrorResponseSchema,
      500: ApiErrorResponseSchema,
    },
    detail: {
      tags: ["External Model"],
      summary: "删除 Model",
      description: "删除指定 Provider ID 下的 Model 配置。",
    },
  },
);

export default app;
