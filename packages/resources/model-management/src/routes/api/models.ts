import type { ActorContext, IdentityDirectory } from "@fenix/platform-sdk";
import { toResourceAccessView } from "@fenix/platform-sdk";
import { AppError } from "@server/errors";
import { authGuardPlugin } from "@server/plugins/auth";
import { ApiErrorResponseSchema } from "@server/schemas/api-common.schema";
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
} from "@server/schemas/api-model.schema";
import Elysia from "elysia";
import type {
  AuthorizedProvider,
  AuthorizedProviderDetail,
  AuthorizedProviderListItem,
  ProviderFacadeApi,
} from "../../server/facades/provider-facade";
import { getModelManagementModule } from "../../server/module-runtime";
import { modelWriteDataFromApi } from "../../server/services/model-write-data";

/**
 * `/api/models` 协议层（对外已发布合同）。
 *
 * 授权与领域编排全部经 `getModelManagementModule().facade`（{@link ProviderFacadeApi}）：route 只做
 * 协议接入、错误映射与响应投影，不再直接触达仓储，也不再自行判断"这一行能不能读/能不能写"。Facade
 * 把授权拒绝映射为宿主错误类（不可见 → 404 `NotFoundError`，无动作或系统托管 → 403 `ForbiddenError`），
 * 由 {@link mapApiError} 翻译成对外状态码。重名判定刻意留在本文件：同一情形在 `/web` 与 `/api` 返回
 * 不同错误码，错误码是协议细节而不是领域规则。
 *
 * `resourceAccess` 是**唯一**保留旧字段形状的位置（决策 D2），由 `toResourceAccessView` 从
 * `scope + access.actions` 派生；Model 相关响应迁移前就不含该字段，此处保持。
 *
 * 分页保持迁移前语义：`facade.list` 给出当前主体可见的全部条目与总数，route 在内存里切片，不引入新的
 * 分页/计数查询；`total` 与 `items` 始终来自同一个可见集合。
 */

/** Provider 详情内嵌的子表行；经 Facade 的返回类型取得，route 不直接依赖仓储类型。 */
type ProviderModelRow = AuthorizedProviderDetail["models"][number];

/** Provider 写入数据；同样经 Facade 签名取得，避免 route 依赖仓储层类型。 */
type ProviderWriteInput = Parameters<ProviderFacadeApi["save"]>[2];

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

/** 派生已发布合同的资源访问视图；组织名称由调用方批量解析后传入。 */
function buildResourceAccess(
  provider: AuthorizedProvider,
  activeOrganizationId: string | undefined,
  sourceOrganizationName: string | undefined,
) {
  return toResourceAccessView({
    resource: { id: provider.id, scope: provider.scope, access: provider.access },
    ...(activeOrganizationId === undefined ? {} : { activeOrganizationId }),
    ...(sourceOrganizationName === undefined ? {} : { sourceOrganizationName }),
  });
}

/** 批量解析归属组织名称；名录不可用时字段整体省略。 */
async function resolveOrganizationNames(
  identity: IdentityDirectory,
  organizationIds: readonly (string | undefined)[],
): Promise<ReadonlyMap<string, string>> {
  const ids = [...new Set(organizationIds.filter((id): id is string => typeof id === "string" && id.length > 0))];
  if (ids.length === 0) return new Map();
  return identity.listOrganizationNames(ids);
}

/**
 * 组装对外 Provider 列表项，避免把内部字段和敏感细节直接暴露给列表接口。
 */
function toProviderListItem(
  provider: AuthorizedProviderListItem,
  activeOrganizationId: string | undefined,
  sourceOrganizationName: string | undefined,
) {
  return {
    id: provider.id,
    name: provider.name,
    displayName: provider.displayName ?? null,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl ?? null,
    modelCount: provider.modelCount ?? 0,
    resourceAccess: buildResourceAccess(provider, activeOrganizationId, sourceOrganizationName),
  };
}

/**
 * 组装对外 Provider 详情。
 *
 * 内嵌的模型摘要走 `toModelSummary` 的单参数形态：父级名称已知，因此摘要里没有 `providerName`，
 * 也不展开 `options`，字段集合与独立的 Model 视图保持迁移前的差异。
 */
function toProviderDetail(
  detail: AuthorizedProviderDetail,
  activeOrganizationId: string | undefined,
  sourceOrganizationName: string | undefined,
) {
  return {
    id: detail.id,
    name: detail.name,
    displayName: detail.displayName ?? null,
    protocol: detail.protocol,
    baseUrl: detail.baseUrl ?? null,
    extraOptions: detail.extraOptions ?? null,
    models: detail.models.map((model) => toModelSummary(detail.id, model)),
    resourceAccess: buildResourceAccess(detail, activeOrganizationId, sourceOrganizationName),
  };
}

/** 详情页只归属一个组织：单条解析名称后直接产响应。 */
async function toProviderDetailResponse(
  detail: AuthorizedProviderDetail,
  actor: ActorContext,
  identity: IdentityDirectory,
) {
  const names = await resolveOrganizationNames(identity, [detail.scope.organizationId]);
  return toProviderDetail(detail, actor.activeOrganizationId, names.get(detail.scope.organizationId ?? ""));
}

/**
 * Model 字段投影：Provider 详情内嵌摘要与独立的 Model 视图共用命名。
 *
 * `providerName` 只在独立的 Model 视图里出现（内嵌摘要的父级名称已知），因此省略时整体不出现在响应中；
 * `options` 只属于 Model 详情，由 {@link toModelDetail} 追加。
 */
function toModelSummary(providerId: string, model: ProviderModelRow, providerName?: string) {
  return {
    providerId,
    id: model.id,
    modelId: model.modelId,
    ...(providerName === undefined ? {} : { providerName }),
    displayName: model.displayName ?? null,
    modalities: model.modalities ?? null,
    limitConfig: model.limitConfig ?? null,
    cost: model.cost ?? null,
  };
}

/** 组装对外 Model 详情；`options` 是自由形状 jsonb 列，非对象（含数组）一律投影为 `null`。 */
function toModelDetail(providerId: string, providerName: string, model: ProviderModelRow) {
  const { options } = model;
  const record = options && typeof options === "object" && !Array.isArray(options) ? options : null;
  return {
    ...toModelSummary(providerId, model, providerName),
    options: record as Record<string, unknown> | null,
  };
}

/**
 * 对外请求体 → Provider 写入数据。
 *
 * 与 Model 写入数据同一空值语义：`undefined` 的键整体省略表示"不修改"，`null` 保留表示"置空"。用条件
 * 展开而不是造可变对象再赋值，是因为 {@link ProviderWriteInput} 的字段是只读的。
 */
function toProviderWriteData(body: ApiProviderUpsertBody | ApiProviderUpdateBody): ProviderWriteInput {
  return {
    ...(body.displayName === undefined ? {} : { displayName: body.displayName }),
    ...(body.protocol === undefined ? {} : { protocol: body.protocol }),
    ...(body.baseUrl === undefined ? {} : { baseUrl: body.baseUrl }),
    ...(body.apiKey === undefined ? {} : { apiKey: body.apiKey }),
    ...(body.extraOptions === undefined ? {} : { extraOptions: body.extraOptions }),
  };
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
    const actor = store.actor as ActorContext | null;
    if (!actor) return error(401, { error: { code: "UNAUTHORIZED", message: "请求缺少组织上下文" } });
    const { page, pageSize } = query as ApiModelListQuery;

    try {
      const { facade, identity } = getModelManagementModule();
      const { items, total } = await facade.list(actor);
      const names = await resolveOrganizationNames(
        identity,
        items.map((item) => item.scope.organizationId),
      );
      const start = (page - 1) * pageSize;
      return {
        items: items
          .slice(start, start + pageSize)
          .map((item) =>
            toProviderListItem(item, actor.activeOrganizationId, names.get(item.scope.organizationId ?? "")),
          ),
        total,
        page,
        pageSize,
      };
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
    const actor = store.actor as ActorContext | null;
    if (!actor) return error(401, { error: { code: "UNAUTHORIZED", message: "请求缺少组织上下文" } });
    const payload = body as ApiProviderUpsertBody;

    try {
      const { facade, identity } = getModelManagementModule();
      const existing = await facade.get(actor, payload.name);
      if (existing) {
        return error(409, { error: { code: "CONFLICT", message: `Provider '${payload.name}' already exists` } });
      }

      const detail = await facade.save(actor, payload.name, toProviderWriteData(payload), {
        publicReadable: payload.publicReadable,
      });
      return await toProviderDetailResponse(detail, actor, identity);
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
    const actor = store.actor as ActorContext | null;
    if (!actor) return error(401, { error: { code: "UNAUTHORIZED", message: "请求缺少组织上下文" } });
    const { providerId } = params as { providerId: string };

    try {
      const { facade, identity } = getModelManagementModule();
      const detail = await facade.getById(actor, providerId);
      if (!detail) {
        return error(404, { error: { code: "NOT_FOUND", message: `Provider '${providerId}' not found` } });
      }
      return await toProviderDetailResponse(detail, actor, identity);
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
    const actor = store.actor as ActorContext | null;
    if (!actor) return error(401, { error: { code: "UNAUTHORIZED", message: "请求缺少组织上下文" } });
    const { providerId } = params as { providerId: string };
    const payload = body as ApiProviderUpdateBody;

    try {
      const { facade, identity } = getModelManagementModule();
      // 可见性、系统托管与 `update` 动作校验都在 Facade 内完成：不可见 → 404，无动作 → 403。
      const detail = await facade.saveById(actor, providerId, toProviderWriteData(payload), {
        publicReadable: payload.publicReadable,
      });
      return await toProviderDetailResponse(detail, actor, identity);
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
    const actor = store.actor as ActorContext | null;
    if (!actor) return error(401, { error: { code: "UNAUTHORIZED", message: "请求缺少组织上下文" } });
    const { providerId } = params as { providerId: string };

    try {
      // 不存在与无 `delete` 动作分别抛出 404 / 403，由 mapApiError 翻译。
      await getModelManagementModule().facade.remove(actor, { by: "resourceId", value: providerId });
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
    const actor = store.actor as ActorContext | null;
    if (!actor) return error(401, { error: { code: "UNAUTHORIZED", message: "请求缺少组织上下文" } });
    const { providerId } = params as { providerId: string };
    const payload = body as ApiModelUpsertBody;

    try {
      const { facade } = getModelManagementModule();
      const detail = await facade.getById(actor, providerId);
      if (!detail) {
        return error(404, { error: { code: "NOT_FOUND", message: `Provider '${providerId}' not found` } });
      }
      // 重名判定留在协议层：仓储侧是幂等 upsert，并发绕过检查只会收敛到同一行，不会产生重复子行。
      if (detail.models.some((model) => model.modelId === payload.modelId)) {
        return error(409, { error: { code: "CONFLICT", message: `Model '${payload.modelId}' already exists` } });
      }

      const result = await facade.addModel(
        actor,
        { by: "resourceId", value: providerId },
        payload.modelId,
        modelWriteDataFromApi(payload),
      );
      const created = result.provider.models.find((model) => model.modelId === result.modelId);
      if (!created) {
        return error(500, { error: { code: "INTERNAL_ERROR", message: "Model could not be reloaded" } });
      }
      return toModelDetail(result.provider.id, result.provider.name, created);
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
    const actor = store.actor as ActorContext | null;
    if (!actor) return error(401, { error: { code: "UNAUTHORIZED", message: "请求缺少组织上下文" } });
    const { providerId } = params as { providerId: string };
    const { page, pageSize } = query as ApiModelListQuery;

    try {
      const { facade } = getModelManagementModule();
      const detail = await facade.getById(actor, providerId);
      if (!detail) {
        return error(404, { error: { code: "NOT_FOUND", message: `Provider '${providerId}' not found` } });
      }

      // 子表没有独立分页查询：取父级详情后在内存里切片，`total` 与 `items` 来自同一份子行集合。
      const models = detail.models.map((model) => toModelSummary(detail.id, model, detail.name));
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
    const actor = store.actor as ActorContext | null;
    if (!actor) return error(401, { error: { code: "UNAUTHORIZED", message: "请求缺少组织上下文" } });
    const { providerId, id } = params as { providerId: string; id: string };

    try {
      const { facade } = getModelManagementModule();
      const detail = await facade.getById(actor, providerId);
      if (!detail) {
        return error(404, { error: { code: "NOT_FOUND", message: `Provider '${providerId}' not found` } });
      }

      const model = detail.models.find((row) => row.id === id);
      if (!model) return error(404, { error: { code: "NOT_FOUND", message: `Model '${id}' not found` } });
      return toModelDetail(detail.id, detail.name, model);
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
    const actor = store.actor as ActorContext | null;
    if (!actor) return error(401, { error: { code: "UNAUTHORIZED", message: "请求缺少组织上下文" } });
    const { providerId, id } = params as { providerId: string; id: string };
    const payload = body as ApiModelUpdateBody;

    try {
      const { facade } = getModelManagementModule();
      // 按行 ID 定位（`/api` 既有合同）：父级与子行任一不可见都会抛 404。
      const result = await facade.updateModel(
        actor,
        { by: "resourceId", value: providerId },
        { by: "id", value: id },
        modelWriteDataFromApi(payload),
      );
      const updated = result.provider.models.find((model) => model.id === id);
      if (!updated) {
        return error(500, { error: { code: "INTERNAL_ERROR", message: "Model could not be reloaded" } });
      }
      return toModelDetail(result.provider.id, result.provider.name, updated);
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
    const actor = store.actor as ActorContext | null;
    if (!actor) return error(401, { error: { code: "UNAUTHORIZED", message: "请求缺少组织上下文" } });
    const { providerId, id } = params as { providerId: string; id: string };

    try {
      // Facade 在删除前已定位过该子行，回传的业务 `modelId` 就是被删行的值，无需再查一次。
      const { facade } = getModelManagementModule();
      const result = await facade.removeModel(actor, { by: "resourceId", value: providerId }, { by: "id", value: id });
      return { providerId, id, modelId: result.modelId, deleted: true as const };
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
