import Elysia from "elysia";
import * as z from "zod/v4";
import { AppError } from "../../errors";
import { type AuthContext, authGuardPlugin } from "../../plugins/auth";
import {
  ApiModelIdParamsSchema,
  ApiModelUpdateBodySchema,
  ApiModelUpsertBodySchema,
  ApiProviderIdParamsSchema,
  ApiProviderOnlyParamsSchema,
  ApiProviderUpdateBodySchema,
  ApiProviderUpsertBodySchema,
} from "../../schemas/api-model.schema";
import * as configPg from "../../services/config/index";
import { buildModelData } from "../../services/config/provider";

function mapApiError(error: unknown): { status: number; body: { error: { code: string; message: string } } } {
  if (error instanceof AppError) {
    return { status: error.statusCode, body: { error: { code: error.code, message: error.message } } };
  }
  return {
    status: 500,
    body: { error: { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : "Unknown error" } },
  };
}

const app = new Elysia({ name: "api-models", prefix: "/api/model" }).use(authGuardPlugin).model({
  "api-provider-id-params": ApiProviderIdParamsSchema,
  "api-model-id-params": ApiModelIdParamsSchema,
  "api-provider-only-params": ApiProviderOnlyParamsSchema,
  "api-provider-create-body": ApiProviderUpsertBodySchema,
  "api-provider-update-body": ApiProviderUpdateBodySchema,
  "api-model-create-body": ApiModelUpsertBodySchema,
  "api-model-update-body": ApiModelUpdateBodySchema,
});

// ── Provider CRUD ────────────────────────────────────────────

/** GET /api/model/providers — 获取提供商列表 */
app.get(
  "/providers",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 类型推断限制
  async ({ store, error }: any) => {
    const authCtx = store.authContext as AuthContext | null;
    if (!authCtx) {
      return error(401, { error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    }
    try {
      const providers = await configPg.listProviders(authCtx);
      return { providers };
    } catch (err) {
      const mapped = mapApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  {
    sessionAuth: true,
    detail: {
      tags: ["External Model"],
      summary: "获取模型列表",
      description: "返回当前组织可见的所有模型（含共享模型）。",
    },
  },
);

/** POST /api/model/providers — 创建提供商 */
app.post(
  "/providers",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 类型推断限制
  async ({ store, body, error }: any) => {
    const authCtx = store.authContext as AuthContext | null;
    if (!authCtx) {
      return error(401, { error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    }
    const payload = body as z.infer<typeof ApiProviderUpsertBodySchema>;
    try {
      await configPg.upsertProvider(
        authCtx,
        payload.name,
        {
          displayName: payload.displayName,
          protocol: payload.protocol,
          baseUrl: payload.baseUrl,
          apiKey: payload.apiKey,
          extraOptions: payload.extraOptions,
        },
        { publicReadable: payload.publicReadable },
      );
      const detail = await configPg.getProvider(authCtx, payload.name);
      if (!detail) throw new AppError("Provider creation failed", "INTERNAL_ERROR", 500);
      return {
        id: detail.name,
        name: detail.name,
        displayName: detail.displayName ?? null,
        protocol: detail.protocol,
        baseUrl: detail.baseUrl ?? null,
        apiKey: detail.apiKey ?? null,
        extraOptions: detail.extraOptions ?? null,
        models: (detail.models ?? []).map((m) => ({
          id: m.modelId,
          name: m.displayName ?? null,
          modalities: m.modalities ?? null,
          limitConfig: m.limitConfig ?? null,
          cost: m.cost ?? null,
        })),
        resourceAccess: detail.resourceAccess,
      };
    } catch (err) {
      const mapped = mapApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  {
    sessionAuth: true,
    body: "api-provider-create-body",
    detail: { tags: ["External Model"], summary: "创建模型", description: "向指定提供商添加一个新的模型配置。" },
  },
);

/** GET /api/model/providers/:id — 获取单个提供商 */
app.get(
  "/providers/:id",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 类型推断限制
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext as AuthContext | null;
    if (!authCtx) {
      return error(401, { error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    }
    const { id } = params as { id: string };
    try {
      const detail = await configPg.getProvider(authCtx, id);
      if (!detail) {
        return error(404, { error: { code: "NOT_FOUND", message: `Provider '${id}' not found` } });
      }
      return {
        id: detail.name,
        name: detail.name,
        displayName: detail.displayName ?? null,
        protocol: detail.protocol,
        baseUrl: detail.baseUrl ?? null,
        apiKey: detail.apiKey ?? null,
        extraOptions: detail.extraOptions ?? null,
        models: (detail.models ?? []).map((m) => ({
          id: m.modelId,
          name: m.displayName ?? null,
          modalities: m.modalities ?? null,
          limitConfig: m.limitConfig ?? null,
          cost: m.cost ?? null,
        })),
        resourceAccess: detail.resourceAccess,
      };
    } catch (err) {
      const mapped = mapApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  {
    sessionAuth: true,
    params: "api-provider-id-params",
    detail: { tags: ["External Model"], summary: "获取模型详细信息", description: "按模型 ID 返回模型配置详情。" },
  },
);

/** PUT /api/model/providers/:id — 修改供应商 */
app.put(
  "/providers/:id",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 类型推断限制
  async ({ store, params, body, error }: any) => {
    const authCtx = store.authContext as AuthContext | null;
    if (!authCtx) {
      return error(401, { error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    }
    const { id } = params as { id: string };
    const payload = body as z.infer<typeof ApiProviderUpdateBodySchema>;
    try {
      const existing = await configPg.assertProviderInternalWritable(authCtx, id);
      if (!existing) {
        return error(404, { error: { code: "NOT_FOUND", message: `Provider '${id}' not found` } });
      }
      await configPg.upsertProvider(
        authCtx,
        id,
        {
          displayName: payload.displayName ?? existing.displayName ?? undefined,
          protocol: payload.protocol ?? existing.protocol,
          baseUrl: payload.baseUrl ?? existing.baseUrl ?? undefined,
          apiKey: payload.apiKey ?? existing.apiKey ?? undefined,
          extraOptions: payload.extraOptions ?? ((existing.extraOptions ?? undefined) as any),
        },
        { publicReadable: payload.publicReadable },
      );
      const detail = await configPg.getProvider(authCtx, id);
      if (!detail) throw new AppError("Provider update failed", "INTERNAL_ERROR", 500);
      return {
        id: detail.name,
        name: detail.name,
        displayName: detail.displayName ?? null,
        protocol: detail.protocol,
        baseUrl: detail.baseUrl ?? null,
        apiKey: detail.apiKey ?? null,
        extraOptions: detail.extraOptions ?? null,
        models: (detail.models ?? []).map((m) => ({
          id: m.modelId,
          name: m.displayName ?? null,
          modalities: m.modalities ?? null,
          limitConfig: m.limitConfig ?? null,
          cost: m.cost ?? null,
        })),
        resourceAccess: detail.resourceAccess,
      };
    } catch (err) {
      const mapped = mapApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  {
    sessionAuth: true,
    params: "api-provider-id-params",
    body: "api-provider-update-body",
    detail: {
      tags: ["External Model"],
      summary: "修改模型配置",
      description: "修改指定模型的显示名称、模态、使用限制等配置。",
    },
  },
);

/** DELETE /api/model/providers/:id — 删除提供商 */
app.delete(
  "/providers/:id",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 类型推断限制
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext as AuthContext | null;
    if (!authCtx) {
      return error(401, { error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    }
    const { id } = params as { id: string };
    try {
      const deleted = await configPg.deleteProvider(authCtx, id);
      if (!deleted) {
        return error(404, { error: { code: "NOT_FOUND", message: `Provider '${id}' not found` } });
      }
      return { id, deleted: true as const };
    } catch (err) {
      const mapped = mapApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  {
    sessionAuth: true,
    params: "api-provider-id-params",
    detail: { tags: ["External Model"], summary: "删除模型配置", description: "删除指定提供商的指定模型配置。" },
  },
);

// ── Model CRUD ───────────────────────────────────────────────

/** POST /api/model/:providerId/models — 创建模型 */
app.post(
  "/:providerId/models",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 类型推断限制
  async ({ store, params, body, error }: any) => {
    const authCtx = store.authContext as AuthContext | null;
    if (!authCtx) {
      return error(401, { error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    }
    const { providerId } = params as { providerId: string };
    const payload = body as z.infer<typeof ApiModelUpsertBodySchema>;
    try {
      const p = await configPg.assertProviderInternalWritable(authCtx, providerId);
      if (!p) {
        return error(404, { error: { code: "NOT_FOUND", message: `Provider '${providerId}' not found` } });
      }
      await configPg.addModel(authCtx, p.id, { modelId: payload.modelId, ...buildModelData(payload) });
      return {
        id: payload.modelId,
        providerName: providerId,
        displayName: payload.displayName ?? null,
        modalities: payload.modalities ?? null,
        limitConfig: payload.limitConfig ?? null,
        cost: payload.cost ?? null,
        options: payload.options ?? null,
      };
    } catch (err) {
      const mapped = mapApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  {
    sessionAuth: true,
    params: "api-provider-only-params",
    body: "api-model-create-body",
    detail: { tags: ["External Model"], summary: "创建模型", description: "向指定提供商添加一个新的模型配置。" },
  },
);

/** GET /api/model/:providerId/models — 获取模型列表 */
app.get(
  "/:providerId/models",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 类型推断限制
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext as AuthContext | null;
    if (!authCtx) {
      return error(401, { error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    }
    const { providerId } = params as { providerId: string };
    try {
      const detail = await configPg.getProvider(authCtx, providerId);
      if (!detail) {
        return error(404, { error: { code: "NOT_FOUND", message: `Provider '${providerId}' not found` } });
      }
      const models = (detail.models ?? []).map((m) => ({
        id: m.modelId,
        providerName: providerId,
        displayName: m.displayName ?? null,
        modalities: m.modalities ?? null,
        limitConfig: m.limitConfig ?? null,
        cost: m.cost ?? null,
      }));
      return { models };
    } catch (err) {
      const mapped = mapApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  {
    sessionAuth: true,
    params: "api-provider-only-params",
    detail: { tags: ["External Model"], summary: "获取模型列表", description: "返回指定提供商下的所有模型列表。" },
  },
);

/** GET /api/model/:providerId/models/:modelId — 获取模型详情 */
app.get(
  "/:providerId/models/:modelId",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 类型推断限制
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext as AuthContext | null;
    if (!authCtx) {
      return error(401, { error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    }
    const { providerId, modelId } = params as { providerId: string; modelId: string };
    try {
      const detail = await configPg.getProvider(authCtx, providerId);
      if (!detail) {
        return error(404, { error: { code: "NOT_FOUND", message: `Provider '${providerId}' not found` } });
      }
      const modelDetail = detail.models?.find((m) => m.modelId === modelId);
      if (!modelDetail) {
        return error(404, { error: { code: "NOT_FOUND", message: `Model '${modelId}' not found` } });
      }
      return {
        id: modelDetail.modelId,
        providerName: providerId,
        displayName: modelDetail.displayName ?? null,
        modalities: modelDetail.modalities ?? null,
        limitConfig: modelDetail.limitConfig ?? null,
        cost: modelDetail.cost ?? null,
        options: modelDetail.options ?? null,
      };
    } catch (err) {
      const mapped = mapApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  {
    sessionAuth: true,
    params: "api-model-id-params",
    detail: { tags: ["External Model"], summary: "获取模型详细信息", description: "按模型 ID 返回模型配置详情。" },
  },
);

/** PUT /api/model/:providerId/models/:modelId — 修改模型 */
app.put(
  "/:providerId/models/:modelId",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 类型推断限制
  async ({ store, params, body, error }: any) => {
    const authCtx = store.authContext as AuthContext | null;
    if (!authCtx) {
      return error(401, { error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    }
    const { providerId, modelId } = params as { providerId: string; modelId: string };
    const payload = body as z.infer<typeof ApiModelUpdateBodySchema>;
    try {
      const p = await configPg.assertProviderInternalWritable(authCtx, providerId);
      if (!p) {
        return error(404, { error: { code: "NOT_FOUND", message: `Provider '${providerId}' not found` } });
      }
      const updated = await configPg.updateModel(authCtx, p.id, modelId, buildModelData(payload));
      if (!updated) {
        return error(404, { error: { code: "NOT_FOUND", message: `Model '${modelId}' not found` } });
      }
      return {
        id: modelId,
        providerName: providerId,
        displayName: payload.displayName ?? null,
        modalities: payload.modalities ?? null,
        limitConfig: payload.limitConfig ?? null,
        cost: payload.cost ?? null,
        options: payload.options ?? null,
      };
    } catch (err) {
      const mapped = mapApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  {
    sessionAuth: true,
    params: "api-model-id-params",
    body: "api-model-update-body",
    detail: {
      tags: ["External Model"],
      summary: "修改模型配置",
      description: "修改指定模型的显示名称、模态、使用限制等配置。",
    },
  },
);

/** DELETE /api/model/:providerId/models/:modelId — 删除模型 */
app.delete(
  "/:providerId/models/:modelId",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 类型推断限制
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext as AuthContext | null;
    if (!authCtx) {
      return error(401, { error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    }
    const { providerId, modelId } = params as { providerId: string; modelId: string };
    try {
      const deleted = await configPg.removeModel(authCtx, providerId, modelId);
      if (!deleted) {
        return error(404, { error: { code: "NOT_FOUND", message: `Model '${modelId}' not found` } });
      }
      return { providerId, modelId, deleted: true as const };
    } catch (err) {
      const mapped = mapApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  {
    sessionAuth: true,
    params: "api-model-id-params",
    detail: { tags: ["External Model"], summary: "删除模型配置", description: "删除指定提供商的指定模型配置。" },
  },
);

export default app;
