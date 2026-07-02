/**
 * Provider 配置路由 — 支持旧 action 分发与 RESTful 双模式
 *
 * 旧模式：POST /config/providers + body.action 分发（保持向后兼容）
 * REST 模式：
 *   GET    /config/providers                        → 列出所有 Provider
 *   POST   /config/providers                        → 创建新 Provider（已存在返回 409）
 *   GET    /config/providers/:name                  → 获取单个 Provider 详情
 *   PUT    /config/providers/:name                  → 更新已有 Provider（不存在返回 404）
 *   DELETE /config/providers/:name                  → 删除 Provider
 *   POST   /config/providers/:name/test             → 测试 Provider 连通性
 *   POST   /config/providers/:name/models           → 为 Provider 添加模型
 *   PUT    /config/providers/:name/models/:modelId  → 更新 Provider 下的模型
 *   DELETE /config/providers/:name/models/:modelId  → 删除 Provider 下的模型
 *   POST   /config/providers/:name/models/test      → 测试模型连通性
 */

import Elysia from "elysia";
import * as z from "zod/v4";
import { AppError } from "../../../errors";
import { type AuthContext, authGuardPlugin } from "../../../plugins/auth";
import { WebOkSchema } from "../../../schemas/common.schema";
import {
  ConfigActionSchema,
  type ConfigBody,
  ConfigBodySchema,
  ModelActionResultResponseSchema,
  ModelTestResponseSchema,
  ProviderDetailResponseSchema,
  ProviderListResponseSchema,
  ProviderSaveResponseSchema,
  ProviderTestResponseSchema,
} from "../../../schemas/config.schema";
import * as configPg from "../../../services/config/index";
import { buildModelData } from "../../../services/config/provider";
import { configError, configSuccess, resolveApiKey, toKeyHint } from "../../../services/config-utils";
import { invalidateAvailableCache } from "./models";

type ProviderBody = {
  action: string;
  name?: string;
  modelId?: string;
  data?: Record<string, unknown>;
  /** inline 测试凭证：传入则跳过 DB 查询，直接使用传入值 */
  apiKey?: string;
  baseURL?: string;
  protocol?: string;
};

type TestErrorCode =
  | "PROVIDER_TEST_LIST_HTTP_ERROR"
  | "PROVIDER_TEST_LIST_RESPONSE_INVALID"
  | "MODEL_TEST_MESSAGE_HTTP_ERROR"
  | "MODEL_TEST_MESSAGE_RESPONSE_INVALID"
  | "CONFIG_TEST_REQUEST_FAILED";

const ProviderRouteErrSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
  data: z.unknown().optional(),
});

/** POST /config/providers 兼容 body schema：action 可选，存在时必须为合法值否则 422 */
const PostProvidersBodySchema = z
  .object({
    action: ConfigActionSchema.optional().describe("配置动作名称（旧模式，可选）。"),
    name: z.string().optional(),
    modelId: z.string().optional(),
    data: z.record(z.string(), z.unknown()).optional(),
    apiKey: z.string().optional(),
    baseURL: z.string().optional(),
    protocol: z.enum(["openai", "anthropic"]).optional(),
  })
  .catchall(z.unknown());

function configErrorStatus(code: string | undefined): 400 | 403 | 404 | 409 | 500 {
  switch (code) {
    case "VALIDATION_ERROR":
      return 400;
    case "FORBIDDEN":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "ALREADY_EXISTS":
      return 409;
    default:
      return 500;
  }
}

const app = new Elysia({ name: "web-config-providers" }).use(authGuardPlugin).model({
  "config-body": ConfigBodySchema,
});

// ── Handler 函数 ──

async function handleList(ctx: AuthContext) {
  const providers = await configPg.listProviders(ctx);
  const list = providers.map((p) => ({
    id: p.name,
    name: p.displayName ?? "",
    protocol: p.protocol,
    keyHint: toKeyHint(p.apiKey),
    baseURL: p.baseUrl ?? null,
    modelCount: p.modelCount,
    resourceAccess: p.resourceAccess,
    resourceKey: p.resourceKey,
  }));
  return configSuccess({ providers: list });
}

async function handleGet(ctx: AuthContext, name: string) {
  const p = await configPg.getProvider(ctx, name);
  if (!p) return configError("NOT_FOUND", `Provider '${name}' not found`);

  const models = (p.models ?? []).map((m) => ({
    id: m.modelId,
    name: m.displayName ?? m.modelId,
    modalities: m.modalities ?? null,
    limit: m.limitConfig ?? null,
    cost: m.cost ?? null,
    providerResourceAccess: m.providerResourceAccess,
  }));

  return configSuccess({
    id: name,
    name: p.displayName ?? "",
    protocol: p.protocol,
    keyHint: toKeyHint(p.apiKey),
    baseURL: p.baseUrl ?? null,
    resourceAccess: p.resourceAccess,
    resourceKey: p.resourceAccess?.resourceKey,
    models,
  });
}

async function handleSet(ctx: AuthContext, name: string, data: Record<string, unknown>) {
  if (!name || typeof name !== "string") return configError("VALIDATION_ERROR", "Provider name is required");

  // 读取现有 provider 以保留 models
  const existing = await configPg.getProvider(ctx, name);
  if (existing?.resourceAccess?.writable === false) {
    throw new AppError("External provider is read-only", "FORBIDDEN", 403);
  }

  // 分解 data 为 PG 字段
  const apiKey = data.apiKey as string | undefined;
  const baseUrl = data.baseURL as string | undefined;
  const rawProtocol = data.protocol;
  const protocol =
    rawProtocol === "anthropic" || rawProtocol === "openai" ? rawProtocol : (existing?.protocol ?? "openai");
  const displayName = (data.name as string) ?? existing?.displayName ?? undefined;
  const publicReadable = typeof data.publicReadable === "boolean" ? data.publicReadable : undefined;

  // 收集 extraOptions：data 中除已知字段外的其他 options
  const knownKeys = new Set(["protocol", "name", "baseURL", "apiKey", "models", "options", "publicReadable"]);
  const extraOptions: Record<string, unknown> = {};
  if (typeof data.options === "object" && data.options !== null) {
    for (const [k, v] of Object.entries(data.options as Record<string, unknown>)) {
      if (k !== "apiKey" && k !== "baseURL") {
        extraOptions[k] = v;
      }
    }
  }
  for (const [k, v] of Object.entries(data)) {
    if (!knownKeys.has(k)) {
      extraOptions[k] = v;
    }
  }

  await configPg.upsertProvider(
    ctx,
    name,
    {
      displayName,
      protocol,
      baseUrl,
      apiKey,
      extraOptions: Object.keys(extraOptions).length > 0 ? extraOptions : undefined,
    },
    { publicReadable },
  );

  // 处理 models（如果有）
  if (data.models && typeof data.models === "object") {
    const providerRecord = await configPg.assertProviderInternalWritable(ctx, name);
    if (providerRecord) {
      const incoming = data.models as Record<string, Record<string, unknown>>;
      for (const [modelId, modelCfg] of Object.entries(incoming)) {
        const existingModel = providerRecord.models?.find((m) => m.modelId === modelId);
        if (existingModel) {
          await configPg.updateModel(ctx, providerRecord.id, modelId, buildModelData(modelCfg));
        } else {
          await configPg.addModel(ctx, providerRecord.id, { modelId, ...buildModelData(modelCfg) });
        }
      }
    }
  }

  invalidateAvailableCache();
  return configSuccess({
    id: name,
    name: displayName,
    protocol,
    keyHint: toKeyHint(apiKey ?? existing?.apiKey),
  });
}

function normalizeProviderBaseUrl(baseUrl: string | null | undefined, protocol: "openai" | "anthropic"): string {
  const fallback = protocol === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com";
  return (baseUrl || fallback).replace(/\/+$/, "");
}

function withVersionedBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
}

async function readErrorDetail(res: Response): Promise<string | undefined> {
  try {
    const detail = (await res.text()).trim().slice(0, 200);
    return detail || undefined;
  } catch {
    return;
  }
}

function configTestError(code: TestErrorCode, data?: Record<string, unknown>) {
  return configError(code, code, data);
}

function getTestFailureReason(error: unknown): { reason: "timeout" | "request_failed"; detail?: string } {
  if (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    return { reason: "timeout" };
  }

  if (error instanceof Error && error.message) {
    return { reason: "request_failed", detail: error.message };
  }

  return { reason: "request_failed" };
}

async function testOpenAICompatibleProvider(baseUrl: string, apiKey: string, signal: AbortSignal) {
  const res = await fetch(`${withVersionedBaseUrl(baseUrl)}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  });

  if (!res.ok) {
    return configTestError("PROVIDER_TEST_LIST_HTTP_ERROR", {
      protocol: "openai",
      status: res.status,
      detail: await readErrorDetail(res),
    });
  }

  const json = (await res.json()) as { data?: Array<{ id?: string }> };
  if (!Array.isArray(json.data)) {
    return configTestError("PROVIDER_TEST_LIST_RESPONSE_INVALID", {
      protocol: "openai",
      reason: "missing_data_array",
    });
  }

  const models = json.data
    .map((model) => model.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (models.length === 0) {
    return configTestError("PROVIDER_TEST_LIST_RESPONSE_INVALID", {
      protocol: "openai",
      reason: "missing_model_id",
    });
  }

  return configSuccess({ models });
}

async function testAnthropicProvider(baseUrl: string, apiKey: string, signal: AbortSignal) {
  const res = await fetch(`${withVersionedBaseUrl(baseUrl)}/models`, {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    signal,
  });

  if (!res.ok) {
    return configTestError("PROVIDER_TEST_LIST_HTTP_ERROR", {
      protocol: "anthropic",
      status: res.status,
      detail: await readErrorDetail(res),
      hint: res.status === 404 || res.status === 405 ? "configure_model_then_test_model" : undefined,
    });
  }

  const json = (await res.json()) as { data?: Array<{ id?: string }> };
  if (!Array.isArray(json.data)) {
    return configTestError("PROVIDER_TEST_LIST_RESPONSE_INVALID", {
      protocol: "anthropic",
      reason: "missing_data_array",
    });
  }

  const models = json.data
    .map((model) => model.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (models.length === 0) {
    return configTestError("PROVIDER_TEST_LIST_RESPONSE_INVALID", {
      protocol: "anthropic",
      reason: "missing_model_id",
    });
  }

  return configSuccess({ models });
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  return content
    .flatMap((part) => {
      if (typeof part === "string") return [part];
      if (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string") {
        return [part.text];
      }
      return [];
    })
    .join("\n")
    .trim();
}

async function testProviderModelMessage(
  provider: NonNullable<Awaited<ReturnType<typeof configPg.getProvider>>>,
  modelId: string,
  signal: AbortSignal,
) {
  const apiKey = resolveApiKey(provider.apiKey) ?? "";
  const baseUrl = normalizeProviderBaseUrl(provider.baseUrl, provider.protocol);

  if (provider.protocol === "anthropic") {
    const res = await fetch(`${withVersionedBaseUrl(baseUrl)}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: 32,
        messages: [{ role: "user", content: "hello" }],
      }),
      signal,
    });

    if (!res.ok) {
      return configTestError("MODEL_TEST_MESSAGE_HTTP_ERROR", {
        protocol: "anthropic",
        status: res.status,
        detail: await readErrorDetail(res),
      });
    }

    const json = (await res.json()) as { content?: unknown };
    const content = extractMessageText(json.content);
    if (!content) {
      return configTestError("MODEL_TEST_MESSAGE_RESPONSE_INVALID", {
        protocol: "anthropic",
        reason: "empty_text",
      });
    }
    return configSuccess({ ok: true, content });
  }

  const res = await fetch(`${withVersionedBaseUrl(baseUrl)}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 32,
    }),
    signal,
  });

  if (!res.ok) {
    return configTestError("MODEL_TEST_MESSAGE_HTTP_ERROR", {
      protocol: "openai",
      status: res.status,
      detail: await readErrorDetail(res),
    });
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
  };
  const content = extractMessageText(json.choices?.[0]?.message?.content);
  if (!content) {
    return configTestError("MODEL_TEST_MESSAGE_RESPONSE_INVALID", {
      protocol: "openai",
      reason: "empty_text",
    });
  }
  return configSuccess({ ok: true, content });
}

async function handleTest(
  ctx: AuthContext,
  name: string,
  inline?: { apiKey?: string; baseURL?: string; protocol?: "openai" | "anthropic" },
) {
  let apiKey: string;
  let baseURL: string;
  let protocol: string;

  if (inline?.apiKey || inline?.baseURL) {
    apiKey = inline.apiKey ?? "";
    baseURL = normalizeProviderBaseUrl(inline.baseURL, inline.protocol ?? "openai");
    protocol = inline.protocol === "anthropic" ? "anthropic" : "openai";
  } else {
    const p = await configPg.assertProviderInternalWritable(ctx, name);
    if (!p) return configError("NOT_FOUND", `Provider '${name}' not found`);
    apiKey = resolveApiKey(p.apiKey) ?? "";
    baseURL = normalizeProviderBaseUrl(p.baseUrl, p.protocol);
    protocol = p.protocol;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      if (protocol === "anthropic") {
        return await testAnthropicProvider(baseURL, apiKey, controller.signal);
      }
      return await testOpenAICompatibleProvider(baseURL, apiKey, controller.signal);
    } finally {
      clearTimeout(timer);
    }
  } catch (e: unknown) {
    const failure = getTestFailureReason(e);
    return configTestError("CONFIG_TEST_REQUEST_FAILED", {
      target: "provider",
      protocol,
      ...failure,
    });
  }
}

async function handleTestModel(ctx: AuthContext, providerName: string, modelId: string) {
  if (!modelId) return configError("VALIDATION_ERROR", "modelId is required");

  const p = await configPg.assertProviderInternalWritable(ctx, providerName);
  if (!p) return configError("NOT_FOUND", `Provider '${providerName}' not found`);

  const existingModel = p.models?.find((m) => m.modelId === modelId);
  if (!existingModel) return configError("NOT_FOUND", `Model '${modelId}' not found`);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      return await testProviderModelMessage(p, modelId, controller.signal);
    } finally {
      clearTimeout(timer);
    }
  } catch (e: unknown) {
    const failure = getTestFailureReason(e);
    return configTestError("CONFIG_TEST_REQUEST_FAILED", {
      target: "model",
      protocol: p.protocol,
      modelId,
      ...failure,
    });
  }
}

async function handleDelete(ctx: AuthContext, name: string) {
  const row = await configPg.assertProviderInternalWritable(ctx, name);
  if (!row) return configError("NOT_FOUND", `Provider '${name}' not found`);
  const deleted = await configPg.deleteProvider(ctx, name);
  if (!deleted) return configError("NOT_FOUND", `Provider '${name}' not found`);
  invalidateAvailableCache();
  return configSuccess(null);
}

async function handleAddModel(ctx: AuthContext, providerName: string, data: Record<string, unknown>) {
  const modelId = data.modelId as string;
  if (!modelId) return configError("VALIDATION_ERROR", "modelId is required");

  const p = await configPg.assertProviderInternalWritable(ctx, providerName);
  if (!p) return configError("NOT_FOUND", `Provider '${providerName}' not found`);

  const existingModel = p.models?.find((m) => m.modelId === modelId);
  if (existingModel) return configError("VALIDATION_ERROR", `Model '${modelId}' already exists`);

  await configPg.addModel(ctx, p.id, { modelId, ...buildModelData(data) });
  invalidateAvailableCache();
  return configSuccess({ modelId });
}

async function handleUpdateModel(
  ctx: AuthContext,
  providerName: string,
  modelId: string,
  data: Record<string, unknown>,
) {
  if (!modelId) return configError("VALIDATION_ERROR", "modelId is required");

  const p = await configPg.assertProviderInternalWritable(ctx, providerName);
  if (!p) return configError("NOT_FOUND", `Provider '${providerName}' not found`);

  const existingModel = p.models?.find((m) => m.modelId === modelId);
  if (!existingModel) return configError("NOT_FOUND", `Model '${modelId}' not found`);

  await configPg.updateModel(ctx, p.id, modelId, buildModelData(data));
  invalidateAvailableCache();
  return configSuccess({ modelId });
}

async function handleRemoveModel(ctx: AuthContext, providerName: string, modelId: string) {
  if (!modelId) return configError("VALIDATION_ERROR", "modelId is required");

  const p = await configPg.assertProviderInternalWritable(ctx, providerName);
  if (!p) return configError("NOT_FOUND", `Provider '${providerName}' not found`);

  const existingModel = p.models?.find((m) => m.modelId === modelId);
  if (!existingModel) return configError("NOT_FOUND", `Model '${modelId}' not found`);

  await configPg.removeModel(ctx, p.id, modelId);
  invalidateAvailableCache();
  return configSuccess(null);
}

// ── REST 包装函数 ──

async function handleCreate(
  ctx: AuthContext,
  body: Record<string, unknown>,
  errorFn: (status: number, data: unknown) => Response,
) {
  const name = body.name as string;
  if (!name || typeof name !== "string") {
    return errorFn(400, configError("VALIDATION_ERROR", "Provider name is required"));
  }

  const existing = await configPg.getProvider(ctx, name);
  if (existing) {
    return errorFn(409, configError("ALREADY_EXISTS", `Provider '${name}' already exists`));
  }

  const data: Record<string, unknown> = {};
  const passthroughKeys = ["protocol", "apiKey", "baseURL", "displayName", "options", "publicReadable", "models"];
  for (const key of passthroughKeys) {
    if (key in body) {
      const mappedKey = key === "displayName" ? "name" : key;
      data[mappedKey] = body[key];
    }
  }
  for (const [k, v] of Object.entries(body)) {
    if (k === "name" || passthroughKeys.includes(k)) continue;
    data[k] = v;
  }

  return handleSet(ctx, name, data);
}

async function handleUpdate(ctx: AuthContext, name: string, data: Record<string, unknown>) {
  const existing = await configPg.getProvider(ctx, name);
  if (!existing) return configError("NOT_FOUND", `Provider '${name}' not found`);
  return handleSet(ctx, name, data);
}

// ── 旧 action 分发逻辑 ──

async function dispatchAction(
  authCtx: AuthContext,
  payload: ProviderBody,
  status: (code: number, body: unknown) => Response,
) {
  switch (payload.action) {
    case "list":
      return await handleList(authCtx);
    case "get":
      return await handleGet(authCtx, payload.name!);
    case "set":
      return await handleSet(authCtx, payload.name!, payload.data!);
    case "test": {
      const protocol =
        payload.protocol === "anthropic"
          ? ("anthropic" as const)
          : payload.protocol === "openai"
            ? ("openai" as const)
            : undefined;
      return await handleTest(authCtx, payload.name!, {
        apiKey: payload.apiKey,
        baseURL: payload.baseURL,
        protocol,
      });
    }
    case "test_model":
      return await handleTestModel(authCtx, payload.name!, payload.modelId!);
    case "delete":
      return await handleDelete(authCtx, payload.name!);
    case "add_model":
      return await handleAddModel(authCtx, payload.name!, payload.data!);
    case "update_model":
      return await handleUpdateModel(authCtx, payload.name!, payload.modelId!, payload.data!);
    case "remove_model":
      return await handleRemoveModel(authCtx, payload.name!, payload.modelId!);
    default:
      return status(400, configError("VALIDATION_ERROR", `Unknown action: ${payload.action}`));
  }
}

function wrapResult(result: unknown, status: (code: number, body: unknown) => Response) {
  if (result && typeof result === "object" && "success" in result && result.success === false) {
    return status(configErrorStatus((result as { error?: { code?: string } }).error?.code), result);
  }
  return result;
}

function wrapError(e: unknown, status: (code: number, body: unknown) => Response) {
  if (e instanceof AppError) {
    return status(e.statusCode, configError(e.code, e.message));
  }
  const message = e instanceof Error ? e.message : "Unknown error";
  return status(500, configError("CONFIG_READ_ERROR", message));
}

// ── Query param helper（解决 resource key 含 / 无法用 :name 路径参数的问题）──
const providerNameQuerySchema = z.object({
  name: z.string().optional().describe("Provider 名称或跨组织资源键（org_id/name）；不传则为列表模式。"),
});

function extractProviderName(query: unknown): string | undefined {
  if (typeof query !== "object" || query === null) return undefined;
  const name = (query as Record<string, unknown>).name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

// ═════════════════════════════════════════════════════════════════════
// REST 路由（query-param 风格，支持含 / 的 resource key）
// 注：旧 :name 路径参数路由保留在后文，用于简单名称的向后兼容
// ═════════════════════════════════════════════════════════════════════

// 宽松响应 schema，兼容各 handler 返回的不同 data 形状
const looseOkSchema = WebOkSchema(z.union([z.looseObject({}), z.null()]));

/** GET /config/providers — 列出所有 Provider（无 name 参数）或获取单个 Provider（有 name 参数） */
app.get(
  "/config/providers",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia query type is loose at runtime
  async ({ store, query, status }: any) => {
    const authCtx = store.authContext!;
    const name = extractProviderName(query);

    // 有 name 参数 → 获取单个 Provider
    if (name) {
      const result: unknown = await handleGet(authCtx, name);
      if (result && typeof result === "object" && "success" in result && result.success === false) {
        return status(configErrorStatus((result as { error?: { code?: string } }).error?.code), result);
      }
      return result;
    }

    return (await handleList(authCtx)) as any;
  },
  {
    sessionAuth: true,
    query: providerNameQuerySchema,
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

// ── PUT /config/providers?name=xxx — 更新已有 Provider ──
app.put(
  "/config/providers",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ store, query, body, status }: any) => {
    const authCtx = store.authContext!;
    const name = extractProviderName(query);
    if (!name) {
      return status(400, configError("VALIDATION_ERROR", "缺少 'name' 查询参数"));
    }
    const data = (body ?? {}) as Record<string, unknown>;
    const result: unknown = await handleUpdate(authCtx, name, data);
    if (result && typeof result === "object" && "success" in result && result.success === false) {
      return status(configErrorStatus((result as { error?: { code?: string } }).error?.code), result);
    }
    return result;
  },
  {
    sessionAuth: true,
    query: providerNameQuerySchema,
    response: {
      200: ProviderSaveResponseSchema,
      400: ProviderRouteErrSchema,
      404: ProviderRouteErrSchema,
    },
    detail: {
      tags: ["ProviderConfig"],
      summary: "更新已有 Provider",
      description:
        "更新指定 Provider 的协议类型、API Key、Base URL 等配置。名称通过 `name` 查询参数传入（支持 resource key 格式）。",
      parameters: [
        {
          name: "name",
          in: "query",
          required: true,
          description: "要更新的 Provider 名称或跨组织资源键。",
          schema: { type: "string" },
        },
      ],
    },
  },
);

// ── DELETE /config/providers?name=xxx — 删除 Provider ──
app.delete(
  "/config/providers",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ store, query, status }: any) => {
    const authCtx = store.authContext!;
    const name = extractProviderName(query);
    if (!name) {
      return status(400, configError("VALIDATION_ERROR", "缺少 'name' 查询参数"));
    }
    const result: unknown = await handleDelete(authCtx, name);
    if (result && typeof result === "object" && "success" in result && result.success === false) {
      return status(configErrorStatus((result as { error?: { code?: string } }).error?.code), result);
    }
    return result;
  },
  {
    sessionAuth: true,
    query: providerNameQuerySchema,
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

// ── Action routes（使用 /actions/ 前缀避免与 :name 路径冲突）──

/** POST /config/providers/actions/test?name=xxx — 测试 Provider 连通性 */
app.post(
  "/config/providers/actions/test",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ store, query, body, status }: any) => {
    const authCtx = store.authContext!;
    const name = extractProviderName(query);
    if (!name) {
      return status(400, configError("VALIDATION_ERROR", "缺少 'name' 查询参数"));
    }
    const inline = body as { apiKey?: string; baseURL?: string; protocol?: string } | undefined;
    const result: unknown = await handleTest(authCtx, name, {
      apiKey: inline?.apiKey,
      baseURL: inline?.baseURL,
      protocol: inline?.protocol === "anthropic" ? "anthropic" : inline?.protocol === "openai" ? "openai" : undefined,
    });
    if (result && typeof result === "object" && "success" in result && result.success === false) {
      return status(configErrorStatus((result as { error?: { code?: string } }).error?.code), result);
    }
    return result;
  },
  {
    sessionAuth: true,
    query: providerNameQuerySchema,
    response: {
      200: ProviderTestResponseSchema,
      400: ProviderRouteErrSchema,
      404: ProviderRouteErrSchema,
      500: ProviderRouteErrSchema,
    },
    detail: {
      tags: ["ProviderConfig"],
      summary: "测试 Provider 连通性",
      description:
        "测试指定 Provider 的连通性，可选择性传入内联凭证。名称通过 `name` 查询参数传入（支持 resource key 格式）。",
      parameters: [
        {
          name: "name",
          in: "query",
          required: true,
          description: "Provider 名称或跨组织资源键。",
          schema: { type: "string" },
        },
      ],
    },
  },
);

/** POST /config/providers/actions/test-model?name=xxx — 测试模型连通性 */
app.post(
  "/config/providers/actions/test-model",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ store, query, body, status }: any) => {
    const authCtx = store.authContext!;
    const name = extractProviderName(query);
    if (!name) {
      return status(400, configError("VALIDATION_ERROR", "缺少 'name' 查询参数"));
    }
    const b = body as { modelId?: string };
    const result: unknown = await handleTestModel(authCtx, name, b?.modelId ?? "");
    if (result && typeof result === "object" && "success" in result && result.success === false) {
      return status(configErrorStatus((result as { error?: { code?: string } }).error?.code), result);
    }
    return result;
  },
  {
    sessionAuth: true,
    query: providerNameQuerySchema,
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
      parameters: [
        {
          name: "name",
          in: "query",
          required: true,
          description: "Provider 名称或跨组织资源键。",
          schema: { type: "string" },
        },
      ],
    },
  },
);

/** POST /config/providers/actions/models?name=xxx — 为 Provider 添加模型 */
app.post(
  "/config/providers/actions/models",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ store, query, body, status }: any) => {
    const authCtx = store.authContext!;
    const name = extractProviderName(query);
    if (!name) {
      return status(400, configError("VALIDATION_ERROR", "缺少 'name' 查询参数"));
    }
    const b = body as { modelId?: string; data?: Record<string, unknown> };
    const result: unknown = await handleAddModel(authCtx, name, { modelId: b?.modelId, ...(b?.data ?? {}) });
    if (result && typeof result === "object" && "success" in result && result.success === false) {
      return status(configErrorStatus((result as { error?: { code?: string } }).error?.code), result);
    }
    return result;
  },
  {
    sessionAuth: true,
    query: providerNameQuerySchema,
    response: {
      200: ModelActionResultResponseSchema,
      400: ProviderRouteErrSchema,
      404: ProviderRouteErrSchema,
    },
    detail: {
      tags: ["ProviderConfig"],
      summary: "为 Provider 添加模型",
      description: "向指定的 Provider 添加一个新的模型配置条目。Provider 名称通过 `name` 查询参数传入。",
      parameters: [
        {
          name: "name",
          in: "query",
          required: true,
          description: "Provider 名称或跨组织资源键。",
          schema: { type: "string" },
        },
      ],
    },
  },
);

/** PUT /config/providers/actions/models/:modelId?name=xxx — 更新 Provider 下的模型 */
app.put(
  "/config/providers/actions/models/:modelId",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ store, query, params, body, status }: any) => {
    const authCtx = store.authContext!;
    const name = extractProviderName(query);
    if (!name) {
      return status(400, configError("VALIDATION_ERROR", "缺少 'name' 查询参数"));
    }
    const modelId = params.modelId as string;
    const b = body as { data?: Record<string, unknown> } | undefined;
    const result: unknown = await handleUpdateModel(authCtx, name, modelId, b?.data ?? {});
    if (result && typeof result === "object" && "success" in result && result.success === false) {
      return status(configErrorStatus((result as { error?: { code?: string } }).error?.code), result);
    }
    return result;
  },
  {
    sessionAuth: true,
    query: providerNameQuerySchema,
    response: {
      200: ModelActionResultResponseSchema,
      400: ProviderRouteErrSchema,
      404: ProviderRouteErrSchema,
    },
    detail: {
      tags: ["ProviderConfig"],
      summary: "更新 Provider 下的模型",
      description: "更新指定 Provider 下某个模型的配置。Provider 名称通过 `name` 查询参数传入。",
      parameters: [
        {
          name: "name",
          in: "query",
          required: true,
          description: "Provider 名称或跨组织资源键。",
          schema: { type: "string" },
        },
        {
          name: "modelId",
          in: "path",
          required: true,
          description: "模型 ID。",
          schema: { type: "string" },
        },
      ],
    },
  },
);

/** DELETE /config/providers/actions/models/:modelId?name=xxx — 删除 Provider 下的模型 */
app.delete(
  "/config/providers/actions/models/:modelId",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ store, query, params, status }: any) => {
    const authCtx = store.authContext!;
    const name = extractProviderName(query);
    if (!name) {
      return status(400, configError("VALIDATION_ERROR", "缺少 'name' 查询参数"));
    }
    const modelId = params.modelId as string;
    const result: unknown = await handleRemoveModel(authCtx, name, modelId);
    if (result && typeof result === "object" && "success" in result && result.success === false) {
      return status(configErrorStatus((result as { error?: { code?: string } }).error?.code), result);
    }
    return result;
  },
  {
    sessionAuth: true,
    query: providerNameQuerySchema,
    response: {
      200: ModelActionResultResponseSchema,
      400: ProviderRouteErrSchema,
      404: ProviderRouteErrSchema,
    },
    detail: {
      tags: ["ProviderConfig"],
      summary: "删除 Provider 下的模型",
      description: "删除指定 Provider 下某个模型的配置条目。Provider 名称通过 `name` 查询参数传入。",
      parameters: [
        {
          name: "name",
          in: "query",
          required: true,
          description: "Provider 名称或跨组织资源键。",
          schema: { type: "string" },
        },
        {
          name: "modelId",
          in: "path",
          required: true,
          description: "模型 ID。",
          schema: { type: "string" },
        },
      ],
    },
  },
);

/** POST /config/providers — 创建新 Provider（REST） / 旧 action 分发（兼容） */
app.post(
  "/config/providers",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia sessionAuth + 双模式兼容
  async ({ store, body, status }: any) => {
    const authCtx = store.authContext!;
    const b = body as Record<string, unknown>;

    try {
      // 兼容旧模式：body 中包含 action 字段走 action 分发
      if (b && typeof b.action === "string") {
        const cfgBody = b as ConfigBody;
        const payload: ProviderBody = {
          action: cfgBody.action ?? "",
          name: cfgBody.name,
          modelId: cfgBody.modelId,
          data: cfgBody.data,
          apiKey: cfgBody.apiKey,
          baseURL: cfgBody.baseURL,
          protocol: cfgBody.protocol,
        };
        const result = await dispatchAction(authCtx, payload, status);
        return wrapResult(result, status);
      }

      // REST 模式：创建新 Provider
      return (await handleCreate(authCtx, b, (code, data) => status(code, data))) as any;
    } catch (e: unknown) {
      return wrapError(e, status);
    }
  },
  {
    sessionAuth: true,
    body: PostProvidersBodySchema,
    response: {
      // 旧 action 分发返回多种 data 形状，使用宽松 schema 避免 Elysia 响应裁剪
      200: WebOkSchema(z.union([z.looseObject({}), z.null()])),
      400: ProviderRouteErrSchema,
      403: ProviderRouteErrSchema,
      404: ProviderRouteErrSchema,
      409: ProviderRouteErrSchema,
      500: ProviderRouteErrSchema,
    },
    detail: {
      tags: ["ProviderConfig"],
      summary: "Provider 配置管理（action 分发）/ 创建新 Provider",
      description:
        "兼容旧 action 分发模式：body 中包含 action 字段则按旧模式分发（list/get/set/test/delete/add_model/update_model/remove_model/test_model）。body 中不包含 action 字段时按 REST 模式创建新 Provider，同名已存在返回 409。",
    },
  },
);

/** GET /config/providers/:name — 获取单个 Provider 详情 */
app.get(
  "/config/providers/:name",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia sessionAuth 注入类型在当前写法下无法稳定推断
  async ({ store, params }: any) => {
    const authCtx = store.authContext!;
    const name = params.name as string;
    return (await handleGet(authCtx, name)) as any;
  },
  {
    sessionAuth: true,
    response: {
      200: ProviderDetailResponseSchema,
      404: ProviderRouteErrSchema,
    },
    detail: {
      tags: ["ProviderConfig"],
      summary: "获取单个 Provider 详情",
      description: "根据 Provider 名称获取其完整配置详情，包括关联的模型列表和资源访问控制信息。",
      parameters: [
        {
          name: "name",
          in: "path",
          required: true,
          description: "Provider 名称。",
          schema: { type: "string" },
        },
      ],
    },
  },
);

/** PUT /config/providers/:name — 更新已有 Provider */
app.put(
  "/config/providers/:name",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia sessionAuth 注入类型在当前写法下无法稳定推断
  async ({ store, params, body }: any) => {
    const authCtx = store.authContext!;
    const name = params.name as string;
    const data = (body ?? {}) as Record<string, unknown>;
    return (await handleUpdate(authCtx, name, data)) as any;
  },
  {
    sessionAuth: true,
    response: {
      200: ProviderSaveResponseSchema,
      400: ProviderRouteErrSchema,
      404: ProviderRouteErrSchema,
    },
    detail: {
      tags: ["ProviderConfig"],
      summary: "更新已有 Provider",
      description: "更新指定 Provider 的协议类型、API Key、Base URL 等配置。若 Provider 不存在返回 404。",
      parameters: [
        {
          name: "name",
          in: "path",
          required: true,
          description: "要更新的 Provider 名称。",
          schema: { type: "string" },
        },
      ],
    },
  },
);

/** DELETE /config/providers/:name — 删除 Provider */
app.delete(
  "/config/providers/:name",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia sessionAuth 注入类型在当前写法下无法稳定推断
  async ({ store, params }: any) => {
    const authCtx = store.authContext!;
    const name = params.name as string;
    return (await handleDelete(authCtx, name)) as any;
  },
  {
    sessionAuth: true,
    response: {
      200: WebOkSchema(z.null()),
      404: ProviderRouteErrSchema,
    },
    detail: {
      tags: ["ProviderConfig"],
      summary: "删除 Provider",
      description: "删除指定的 Provider 配置及其关联数据。",
      parameters: [
        {
          name: "name",
          in: "path",
          required: true,
          description: "要删除的 Provider 名称。",
          schema: { type: "string" },
        },
      ],
    },
  },
);

/** POST /config/providers/:name/test — 测试 Provider 连通性 */
app.post(
  "/config/providers/:name/test",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia sessionAuth 注入类型在当前写法下无法稳定推断
  async ({ store, params, body }: any) => {
    const authCtx = store.authContext!;
    const name = params.name as string;
    const inline = body as { apiKey?: string; baseURL?: string; protocol?: string } | undefined;

    return (await handleTest(authCtx, name, {
      apiKey: inline?.apiKey,
      baseURL: inline?.baseURL,
      protocol: inline?.protocol === "anthropic" ? "anthropic" : inline?.protocol === "openai" ? "openai" : undefined,
    })) as any;
  },
  {
    sessionAuth: true,
    response: {
      200: ProviderTestResponseSchema,
      400: ProviderRouteErrSchema,
      404: ProviderRouteErrSchema,
      500: ProviderRouteErrSchema,
    },
    detail: {
      tags: ["ProviderConfig"],
      summary: "测试 Provider 连通性",
      description: "测试指定 Provider 的连通性，可选择性传入内联凭证（apiKey/baseURL/protocol）以在未保存时进行测试。",
      parameters: [
        {
          name: "name",
          in: "path",
          required: true,
          description: "Provider 名称。",
          schema: { type: "string" },
        },
      ],
    },
  },
);

/** POST /config/providers/:name/models — 为 Provider 添加模型 */
app.post(
  "/config/providers/:name/models",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia sessionAuth 注入类型在当前写法下无法稳定推断
  async ({ store, params, body }: any) => {
    const authCtx = store.authContext!;
    const name = params.name as string;
    const b = body as { modelId?: string; data?: Record<string, unknown> };
    return (await handleAddModel(authCtx, name, { modelId: b?.modelId, ...(b?.data ?? {}) })) as any;
  },
  {
    sessionAuth: true,
    response: {
      200: ModelActionResultResponseSchema,
      400: ProviderRouteErrSchema,
      404: ProviderRouteErrSchema,
    },
    detail: {
      tags: ["ProviderConfig"],
      summary: "为 Provider 添加模型",
      description: "向指定的 Provider 添加一个新的模型配置条目。body 中包含 modelId 和模型配置 data。",
      parameters: [
        {
          name: "name",
          in: "path",
          required: true,
          description: "Provider 名称。",
          schema: { type: "string" },
        },
      ],
    },
  },
);

/** PUT /config/providers/:name/models/:modelId — 更新 Provider 下的模型 */
app.put(
  "/config/providers/:name/models/:modelId",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia sessionAuth 注入类型在当前写法下无法稳定推断
  async ({ store, params, body }: any) => {
    const authCtx = store.authContext!;
    const name = params.name as string;
    const modelId = params.modelId as string;
    const b = body as { data?: Record<string, unknown> } | undefined;
    return (await handleUpdateModel(authCtx, name, modelId, b?.data ?? {})) as any;
  },
  {
    sessionAuth: true,
    response: {
      200: ModelActionResultResponseSchema,
      400: ProviderRouteErrSchema,
      404: ProviderRouteErrSchema,
    },
    detail: {
      tags: ["ProviderConfig"],
      summary: "更新 Provider 下的模型",
      description: "更新指定 Provider 下某个模型的配置。body 中包含模型配置 data。",
      parameters: [
        {
          name: "name",
          in: "path",
          required: true,
          description: "Provider 名称。",
          schema: { type: "string" },
        },
        {
          name: "modelId",
          in: "path",
          required: true,
          description: "模型 ID。",
          schema: { type: "string" },
        },
      ],
    },
  },
);

/** DELETE /config/providers/:name/models/:modelId — 删除 Provider 下的模型 */
app.delete(
  "/config/providers/:name/models/:modelId",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia sessionAuth 注入类型在当前写法下无法稳定推断
  async ({ store, params }: any) => {
    const authCtx = store.authContext!;
    const name = params.name as string;
    const modelId = params.modelId as string;
    return (await handleRemoveModel(authCtx, name, modelId)) as any;
  },
  {
    sessionAuth: true,
    response: {
      200: ModelActionResultResponseSchema,
      400: ProviderRouteErrSchema,
      404: ProviderRouteErrSchema,
    },
    detail: {
      tags: ["ProviderConfig"],
      summary: "删除 Provider 下的模型",
      description: "删除指定 Provider 下某个模型的配置条目。",
      parameters: [
        {
          name: "name",
          in: "path",
          required: true,
          description: "Provider 名称。",
          schema: { type: "string" },
        },
        {
          name: "modelId",
          in: "path",
          required: true,
          description: "模型 ID。",
          schema: { type: "string" },
        },
      ],
    },
  },
);

/** POST /config/providers/:name/models/test — 测试模型连通性 */
app.post(
  "/config/providers/:name/models/test",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia sessionAuth 注入类型在当前写法下无法稳定推断
  async ({ store, params, body }: any) => {
    const authCtx = store.authContext!;
    const name = params.name as string;
    const b = body as { modelId?: string };
    return (await handleTestModel(authCtx, name, b?.modelId ?? "")) as any;
  },
  {
    sessionAuth: true,
    response: {
      200: ModelTestResponseSchema,
      400: ProviderRouteErrSchema,
      404: ProviderRouteErrSchema,
      500: ProviderRouteErrSchema,
    },
    detail: {
      tags: ["ProviderConfig"],
      summary: "测试模型连通性",
      description: "测试指定 Provider 下某个模型的连通性，通过发送简单对话请求验证模型可用性。body 中包含 modelId。",
      parameters: [
        {
          name: "name",
          in: "path",
          required: true,
          description: "Provider 名称。",
          schema: { type: "string" },
        },
      ],
    },
  },
);

export default app;
