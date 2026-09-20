/**
 * Provider 配置路由 — RESTful 风格（query-param 命名以支持含 / 的 resource key）
 *
 *   GET    /config/providers?name=xxx                          → 获取单个 / 无 name 时列出全部
 *   PUT    /config/providers?name=xxx                          → 保存 Provider（不存在则创建）
 *   DELETE /config/providers?name=xxx                          → 删除 Provider
 *   POST   /config/providers/actions/fetch-models?name=xxx     → 获取 Provider 模型列表
 *   POST   /config/providers/actions/test-model?name=xxx       → 测试模型连通性
 *   POST   /config/providers/actions/models?name=xxx           → 为 Provider 添加模型
 *   PUT    /config/providers/actions/models/:modelId?name=xxx  → 更新模型
 *   DELETE /config/providers/actions/models/:modelId?name=xxx  → 删除模型
 *
 * 本文件只有路由声明与协议参数校验；handler 在 `./provider-handlers`，信封在 `./web-envelope`，
 * 视图投影在 `./provider-views`。
 *
 * 迁移前文件头注释里承诺的 `POST /config/providers`（创建，已存在返回 409）从未注册——PUT 从一开始
 * 就是"不存在则创建"的幂等 upsert，因此这里不再保留那条死路由，也不再有 409 分支。
 *
 * 路由改为**工厂**：会话守卫与密钥引用解析由宿主在装配阶段注入（Elysia 的 `macro` / `state` 是实例
 * 作用域的，包内自建守卫会让 `/web` 出现两套互不可见的认证状态），见 `../../dependencies`。
 */

import { ValidationError, WebOkSchema } from "@fenix/platform-sdk";
import Elysia from "elysia";
import * as z from "zod/v4";
import {
  ModelActionResultResponseSchema,
  ModelTestResponseSchema,
  ProviderFetchModelsResponseSchema,
  ProviderSaveResponseSchema,
} from "../../../schemas/config.schema";
import type { WebConfigProvidersRouteDependencies } from "../../dependencies";
import {
  handleAddModel,
  handleFetchModels,
  handleProviderDelete,
  handleProviderGet,
  handleProviderList,
  handleProviderSet,
  handleRemoveModel,
  handleTestModel,
  handleUpdateModel,
} from "./provider-handlers";
import { safeWebHandler } from "./web-envelope";

/** 错误响应 schema；与迁移前逐字一致（含 `data`，探测类失败会带诊断信息）。 */
const ProviderRouteErrSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
  data: z.unknown().optional(),
});

/** 宽松成功 schema：各 handler 返回的 data 形状不同（列表 / 详情 / null）。 */
const looseOkSchema = WebOkSchema(z.union([z.looseObject({}), z.null()]));

const nameQuerySchema = z.object({
  name: z.string().optional().describe("Provider 名称或跨组织资源键（org_id/名称）；不传则为列表模式。"),
});

/**
 * `name` 走 query 而不是路径参数：跨组织资源键形如 `org_id/name`，含 `/` 无法作为单个路径段。
 * 缺参时抛 `ValidationError`（400 + `VALIDATION_ERROR`），错误码与文案保持迁移前一致。
 */
function requireName(query: unknown): string {
  const name = typeof query === "object" && query !== null ? (query as Record<string, unknown>).name : undefined;
  if (typeof name !== "string" || name.length === 0) {
    throw new ValidationError("缺少 'name' 查询参数");
  }
  return name;
}

const modelIdParameter = {
  name: "modelId",
  in: "path",
  required: true,
  description: "模型 ID。",
  schema: { type: "string" },
} as const;

const providerNameParameter = {
  name: "name",
  in: "query",
  required: true,
  description: "Provider 名称或跨组织资源键。",
  schema: { type: "string" },
} as const;

/**
 * 构造 `/web/config/providers` 路由。
 *
 * 守卫与密钥引用解析由宿主注入而不是包内自建：前者必须与宿主的认证解析同实例（见
 * `../../dependencies` 的说明），后者读 `process.env`，包内 `src/**` 禁止读环境变量。
 */
export function createWebConfigProvidersRoutes(deps: WebConfigProvidersRouteDependencies) {
  const { authGuardPlugin, resolveSecretReference } = deps;
  const app = new Elysia({ name: "web-config-providers" }).use(authGuardPlugin);

  /** GET /config/providers — 列出所有 Provider（无 name 参数）或获取单个 Provider（有 name 参数） */
  app.get(
    "/config/providers",
    safeWebHandler(async (ctx, actor) => {
      const raw = ctx.query?.name;
      return typeof raw === "string" && raw.length > 0
        ? handleProviderGet(actor, raw, resolveSecretReference)
        : handleProviderList(actor, resolveSecretReference);
    }),
    {
      sessionAuth: true,
      query: nameQuerySchema,
      response: {
        200: looseOkSchema,
        400: ProviderRouteErrSchema,
        404: ProviderRouteErrSchema,
      },
      detail: {
        tags: ["ProviderConfig"],
        summary: "列出所有 Provider 或获取单个 Provider",
        description:
          "不带 `name` 查询参数时返回当前组织可见的 LLM Provider 列表。带 `name` 时返回指定 Provider 的完整详情（支持 resource key 格式 org_id/name）。",
        parameters: [
          {
            name: "name",
            in: "query",
            required: false,
            description: "Provider 名称或跨组织资源键；传入后接口切换为详情查询模式。",
            schema: { type: "string" },
          },
        ],
      },
    },
  );

  /** PUT /config/providers?name=xxx — 保存 Provider，不存在则创建 */
  app.put(
    "/config/providers",
    safeWebHandler(async (ctx, actor) =>
      handleProviderSet(
        actor,
        requireName(ctx.query),
        (ctx.body ?? {}) as Record<string, unknown>,
        resolveSecretReference,
      ),
    ),
    {
      sessionAuth: true,
      query: nameQuerySchema,
      response: {
        200: ProviderSaveResponseSchema,
        400: ProviderRouteErrSchema,
        404: ProviderRouteErrSchema,
      },
      detail: {
        tags: ["ProviderConfig"],
        summary: "更新已有 Provider",
        description:
          "更新指定 Provider 的协议类型、API Key、Base URL 等配置；不存在时创建。名称通过 `name` 查询参数传入（支持 resource key 格式）。",
        parameters: [
          {
            name: "name",
            in: "query",
            required: true,
            description: "要更新（或创建）的 Provider 名称或跨组织资源键。",
            schema: { type: "string" },
          },
        ],
      },
    },
  );

  /** DELETE /config/providers?name=xxx — 删除 Provider */
  app.delete(
    "/config/providers",
    safeWebHandler(async (ctx, actor) => handleProviderDelete(actor, requireName(ctx.query))),
    {
      sessionAuth: true,
      query: nameQuerySchema,
      response: {
        200: WebOkSchema(z.null()),
        404: ProviderRouteErrSchema,
      },
      detail: {
        tags: ["ProviderConfig"],
        summary: "删除 Provider",
        description: "删除指定的 Provider 配置及其关联数据。名称通过 `name` 查询参数传入（支持 resource key 格式）。",
        parameters: [
          {
            name: "name",
            in: "query",
            required: true,
            description: "要删除的 Provider 名称或跨组织资源键。",
            schema: { type: "string" },
          },
        ],
      },
    },
  );

  /** POST /config/providers/actions/fetch-models?name=xxx — 获取 Provider 模型列表 */
  app.post(
    "/config/providers/actions/fetch-models",
    safeWebHandler(async (ctx, actor) => {
      const inline = ctx.body as { apiKey?: string; baseURL?: string; protocol?: string } | undefined;
      return handleFetchModels(
        actor,
        requireName(ctx.query),
        {
          apiKey: inline?.apiKey,
          baseURL: inline?.baseURL,
          protocol:
            inline?.protocol === "anthropic" ? "anthropic" : inline?.protocol === "openai" ? "openai" : undefined,
        },
        resolveSecretReference,
      );
    }),
    {
      sessionAuth: true,
      query: nameQuerySchema,
      response: {
        200: ProviderFetchModelsResponseSchema,
        400: ProviderRouteErrSchema,
        404: ProviderRouteErrSchema,
        500: ProviderRouteErrSchema,
      },
      detail: {
        tags: ["ProviderConfig"],
        summary: "获取 Provider 模型列表",
        description:
          "获取指定 Provider 的模型列表，可选择性传入内联凭证。名称通过 `name` 查询参数传入（支持 resource key 格式）。",
        parameters: [providerNameParameter],
      },
    },
  );

  /** POST /config/providers/actions/test-model?name=xxx — 测试模型连通性 */
  app.post(
    "/config/providers/actions/test-model",
    safeWebHandler(async (ctx, actor) => {
      const modelId = (ctx.body as { modelId?: string } | undefined)?.modelId ?? "";
      return handleTestModel(actor, requireName(ctx.query), modelId, resolveSecretReference);
    }),
    {
      sessionAuth: true,
      query: nameQuerySchema,
      response: {
        200: ModelTestResponseSchema,
        400: ProviderRouteErrSchema,
        404: ProviderRouteErrSchema,
        500: ProviderRouteErrSchema,
      },
      detail: {
        tags: ["ProviderConfig"],
        summary: "测试模型连通性",
        description: "测试指定 Provider 下某个模型的连通性。Provider 名称通过 `name` 查询参数传入。",
        parameters: [providerNameParameter],
      },
    },
  );

  /** POST /config/providers/actions/models?name=xxx — 为 Provider 添加模型 */
  app.post(
    "/config/providers/actions/models",
    safeWebHandler(async (ctx, actor) =>
      handleAddModel(actor, requireName(ctx.query), (ctx.body ?? {}) as Record<string, unknown>),
    ),
    {
      sessionAuth: true,
      query: nameQuerySchema,
      response: {
        200: ModelActionResultResponseSchema,
        400: ProviderRouteErrSchema,
        404: ProviderRouteErrSchema,
      },
      detail: {
        tags: ["ProviderConfig"],
        summary: "为 Provider 添加模型",
        description: "向指定的 Provider 添加一个新的模型配置条目。Provider 名称通过 `name` 查询参数传入。",
        parameters: [providerNameParameter],
      },
    },
  );

  /** PUT /config/providers/actions/models/:modelId?name=xxx — 更新 Provider 下的模型 */
  app.put(
    "/config/providers/actions/models/:modelId",
    safeWebHandler(async (ctx, actor) =>
      handleUpdateModel(
        actor,
        requireName(ctx.query),
        ctx.params.modelId as string,
        (ctx.body ?? {}) as Record<string, unknown>,
      ),
    ),
    {
      sessionAuth: true,
      query: nameQuerySchema,
      response: {
        200: ModelActionResultResponseSchema,
        400: ProviderRouteErrSchema,
        404: ProviderRouteErrSchema,
      },
      detail: {
        tags: ["ProviderConfig"],
        summary: "更新 Provider 下的模型",
        description: "更新指定 Provider 下某个模型的配置。Provider 名称通过 `name` 查询参数传入。",
        parameters: [providerNameParameter, modelIdParameter],
      },
    },
  );

  /** DELETE /config/providers/actions/models/:modelId?name=xxx — 删除 Provider 下的模型 */
  app.delete(
    "/config/providers/actions/models/:modelId",
    safeWebHandler(async (ctx, actor) =>
      handleRemoveModel(actor, requireName(ctx.query), ctx.params.modelId as string),
    ),
    {
      sessionAuth: true,
      query: nameQuerySchema,
      response: {
        200: ModelActionResultResponseSchema,
        400: ProviderRouteErrSchema,
        404: ProviderRouteErrSchema,
      },
      detail: {
        tags: ["ProviderConfig"],
        summary: "删除 Provider 下的模型",
        description: "删除指定 Provider 下某个模型的配置条目。Provider 名称通过 `name` 查询参数传入。",
        parameters: [providerNameParameter, modelIdParameter],
      },
    },
  );

  return app;
}
