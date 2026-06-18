import { inArray } from "drizzle-orm";
import Elysia from "elysia";
import * as z from "zod/v4";
import { db } from "../../../db";
import { model as modelTable } from "../../../db/schema";
import { AppError } from "../../../errors";
import { type AuthContext, authGuardPlugin } from "../../../plugins/auth";
import { type ConfigBody, ConfigBodySchema } from "../../../schemas/config.schema";
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

const app = new Elysia({ name: "web-config-providers" }).use(authGuardPlugin).model({
  "config-body": ConfigBodySchema,
  "provider-name-param": z
    .object({
      name: z.string().describe("Provider 名称或跨组织共享资源键（resourceKey）。"),
    })
    .describe("Provider 路径参数。"),
  "provider-name-modelid-params": z
    .object({
      name: z.string().describe("Provider 名称或跨组织共享资源键（resourceKey）。"),
      modelId: z.string().describe("模型 ID。"),
    })
    .describe("Provider 模型嵌套路径参数。"),
  "config-response": z
    .object({
      success: z.boolean().describe("接口调用是否成功。true 表示成功，false 表示失败。"),
      data: z.any().optional().describe("成功时的响应数据，不同接口返回结构不同。"),
      error: z
        .object({
          code: z.string().describe("错误码。"),
          message: z.string().describe("错误描述信息。"),
        })
        .optional()
        .describe("失败时的错误信息。"),
    })
    .passthrough()
    .describe("Provider 配置通用响应。"),
});

async function handleList(ctx: AuthContext) {
  const providers = await configPg.listProviders(ctx);

  // 批量加载模型（加载失败时返回空列表，不影响 provider 列表）
  const modelsByProviderId: Record<string, Array<{ modelId: string; displayName: string | null }>> = {};
  try {
    const providerIds = providers.map((p) => p.id).filter(Boolean);
    if (providerIds.length > 0) {
      const modelRows = await db
        .select({
          providerId: modelTable.providerId,
          modelId: modelTable.modelId,
          displayName: modelTable.displayName,
        })
        .from(modelTable)
        .where(inArray(modelTable.providerId, providerIds));
      for (const m of modelRows) {
        const pid = m.providerId;
        if (!modelsByProviderId[pid]) modelsByProviderId[pid] = [];
        modelsByProviderId[pid].push(m);
      }
    }
  } catch {
    // 模型加载失败时忽略，仅返回 modelCount
  }

  const list = providers.map((p) => ({
    id: p.name,
    name: p.displayName ?? "",
    protocol: p.protocol,
    keyHint: toKeyHint(p.apiKey),
    baseURL: p.baseUrl ?? null,
    modelCount: p.modelCount,
    models: (modelsByProviderId[p.id] ?? []).map((m) => ({
      modelId: m.modelId,
      name: m.displayName ?? m.modelId,
    })),
    resourceAccess: p.resourceAccess,
    resourceKey: p.resourceKey,
  }));
  return configSuccess({ providers: list });
}

async function handleGet(ctx: AuthContext, name: string) {
  // 同时支持按名称和跨组织共享资源键（resourceKey）查找，与 MCP 的 handleGet 逻辑一致
  const p = name.includes("/")
    ? await configPg.getProviderByResourceKey(ctx, name)
    : await configPg.getProvider(ctx, name);
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

/** 新建提供商（含名称重复校验） */
async function handleCreate(ctx: AuthContext, name: string, data: Record<string, unknown>) {
  if (!name || typeof name !== "string") return configError("VALIDATION_ERROR", "Provider name is required");

  const existing = await configPg.getProvider(ctx, name);
  if (existing) {
    return configError("ALREADY_EXISTS", `Provider '${name}' already exists`);
  }
  return handleSet(ctx, name, data);
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
  const displayName = (data.displayName as string) ?? existing?.displayName ?? undefined;
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

/**
 * 规范化 provider base URL，避免尾部 `/` 导致路径重复拼接。
 */
function normalizeProviderBaseUrl(baseUrl: string | null | undefined, protocol: "openai" | "anthropic"): string {
  const fallback = protocol === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com";
  return (baseUrl || fallback).replace(/\/+$/, "");
}

/**
 * 在 provider base URL 后补齐协议约定的 `/v1` 前缀。
 */
function withVersionedBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
}

/**
 * 将上游响应体裁剪成可展示的简短细节，避免错误弹窗被大段 HTML 或 JSON 淹没。
 */
async function readErrorDetail(res: Response): Promise<string | undefined> {
  try {
    const detail = (await res.text()).trim().slice(0, 200);
    return detail || undefined;
  } catch {
    return;
  }
}

/**
 * 统一返回测试相关的结构化错误，供前端按 code 做本地化渲染。
 */
function configTestError(code: TestErrorCode, data?: Record<string, unknown>) {
  return configError(code, code, data);
}

/**
 * 将超时和普通网络异常区分开，前端可据此给出更准确提示。
 */
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
    // inline 模式：直接使用传入的凭证，不查 DB（用于表单内预览模型列表）
    apiKey = inline.apiKey ?? "";
    baseURL = normalizeProviderBaseUrl(inline.baseURL, inline.protocol ?? "openai");
    protocol = inline.protocol === "anthropic" ? "anthropic" : "openai";
  } else {
    // 标准模式：从已保存的 provider 加载凭证
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

// ────────────────────────────────────────────
// Provider 管理（RESTful 接口）
// ────────────────────────────────────────────

/** 获取 Provider 列表 */
app.get(
  "/config/providers",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store }: any) => {
    const authCtx = store.authContext!;
    try {
      return await handleList(authCtx);
    } catch (e: unknown) {
      if (e instanceof AppError) return configError(e.code, e.message);
      return configError("CONFIG_READ_ERROR", e instanceof Error ? e.message : "Unknown error");
    }
  },
  {
    sessionAuth: true,
    detail: {
      tags: ["ProviderConfig"],
      summary: "获取 Provider 列表",
      description:
        "返回当前组织下所有 Provider 供应商列表。每项包含供应商名称、协议类型（openai/anthropic）、API Key 掩码、Base URL、模型数量和跨组织访问控制信息。\n\n200 成功响应: data.providers[] — 包含 id, name, protocol, keyHint, baseURL, modelCount, resourceAccess\n400 参数错误 / 403 无权限 / 404 不存在 / 500 内部错误",
      responses: {
        "200": {
          description:
            "成功返回 Provider 列表。data.providers[]: id, name, protocol(openai/anthropic), keyHint, baseURL, modelCount, resourceAccess, resourceKey。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: true },
                  data: {
                    type: "object",
                    properties: {
                      providers: {
                        type: "array",
                        description: "Provider 列表",
                        items: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            name: { type: "string" },
                            protocol: { type: "string", enum: ["openai", "anthropic"] },
                            keyHint: { type: "string" },
                            baseURL: { type: "string" },
                            modelCount: { type: "number" },
                            resourceAccess: { type: "object" },
                            resourceKey: { type: "string" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "400": {
          description: "请求参数错误。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } },
                },
              },
            },
          },
        },
        "403": {
          description: "无权限操作，外部共享资源不可写。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } },
                },
              },
            },
          },
        },
        "404": {
          description: "资源不存在。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } },
                },
              },
            },
          },
        },
        "500": {
          description: "服务器内部错误。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } },
                },
              },
            },
          },
        },
      } as any,
    },
  },
);

/** 获取单个 Provider 详情 */
app.get(
  "/config/providers/:name",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, params }: any) => {
    const authCtx = store.authContext!;
    try {
      return await handleGet(authCtx, params.name);
    } catch (e: unknown) {
      if (e instanceof AppError) return configError(e.code, e.message);
      return configError("CONFIG_READ_ERROR", e instanceof Error ? e.message : "Unknown error");
    }
  },
  {
    sessionAuth: true,
    params: "provider-name-param" as any,
    detail: {
      tags: ["ProviderConfig"],
      summary: "获取 Provider 详情",
      description:
        "根据名称获取单个 Provider 的详细配置，包括协议类型、API Key 掩码、Base URL 和该 Provider 下的所有模型列表。支持通过 resourceKey 访问外部共享 Provider。\n\n200 成功响应: data — 包含 id, name, protocol, keyHint, baseURL, models[], resourceAccess\n400 参数错误 / 403 无权限 / 404 不存在 / 500 内部错误",
      responses: {
        "200": {
          description:
            "成功返回 Provider 详情。data: id, name, protocol, keyHint, baseURL, resourceAccess, resourceKey, models[]。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: true },
                  data: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      name: { type: "string" },
                      protocol: { type: "string", enum: ["openai", "anthropic"] },
                      keyHint: { type: "string" },
                      baseURL: { type: "string" },
                      resourceAccess: { type: "object" },
                      resourceKey: { type: "string" },
                      models: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            name: { type: "string" },
                            modalities: { type: "string" },
                            limit: { type: "object" },
                            cost: { type: "object" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "404": {
          description: "资源不存在。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } },
                },
              },
            },
          },
        },
        "500": {
          description: "服务器内部错误。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } },
                },
              },
            },
          },
        },
      } as any,
    },
  },
);

/** 创建新 Provider */
app.post(
  "/config/providers",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ store, body, error }: any) => {
    const authCtx = store.authContext!;
    const { name, ...data } = body ?? {};
    try {
      if (!name) return error(400, configError("VALIDATION_ERROR", "name is required"));
      return await handleCreate(authCtx, name, data);
    } catch (e: unknown) {
      if (e instanceof AppError) return error(e.statusCode, configError(e.code, e.message));
      return error(500, configError("CONFIG_WRITE_ERROR", e instanceof Error ? e.message : "Unknown error"));
    }
  },
  {
    sessionAuth: true,
    detail: {
      tags: ["ProviderConfig"],
      summary: "创建 Provider",
      description:
        "创建一个新的 Provider 供应商配置。请求体需包含 name（唯一标识）和协议相关参数（apiKey、baseURL、protocol）。创建时会检查名称是否已存在。\n\n200 成功响应: data — 包含 id, name, protocol, keyHint\n400 参数错误 / 409 名称已存在 / 500 内部错误",
      responses: {
        "200": {
          description: "操作成功。data: id, name, protocol, keyHint。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: true },
                  data: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      name: { type: "string" },
                      protocol: { type: "string", enum: ["openai", "anthropic"] },
                      keyHint: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
        "400": {
          description: "请求参数错误。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } },
                },
              },
            },
          },
        },
        "403": {
          description: "无权限操作，外部共享资源不可写。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } },
                },
              },
            },
          },
        },
        "404": {
          description: "资源不存在。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } },
                },
              },
            },
          },
        },
        "500": {
          description: "服务器内部错误。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } },
                },
              },
            },
          },
        },
      } as any,
    },
  },
);

/** 更新 Provider */
app.put(
  "/config/providers/:name",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ store, params, body, error }: any) => {
    const authCtx = store.authContext!;
    try {
      return await handleSet(authCtx, params.name, body ?? {});
    } catch (e: unknown) {
      if (e instanceof AppError) return error(e.statusCode, configError(e.code, e.message));
      return error(500, configError("CONFIG_WRITE_ERROR", e instanceof Error ? e.message : "Unknown error"));
    }
  },
  {
    sessionAuth: true,
    params: "provider-name-param" as any,
    detail: {
      tags: ["ProviderConfig"],
      summary: "更新 Provider",
      description:
        "更新指定 Provider 的配置信息。支持修改协议类型、API Key、Base URL 和展示名称。请求体中只包含需要更新的字段，未提供的字段保持不变。\n\n200 成功响应: data — 包含 id, name, protocol, keyHint\n400 参数错误 / 403 无权限 / 404 不存在 / 500 内部错误",
      responses: {
        "200": {
          description: "操作成功。data: id, name, protocol, keyHint。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: true },
                  data: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      name: { type: "string" },
                      protocol: { type: "string", enum: ["openai", "anthropic"] },
                      keyHint: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
        "403": {
          description: "无权限操作，外部共享资源不可写。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } },
                },
              },
            },
          },
        },
        "404": {
          description: "资源不存在。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } },
                },
              },
            },
          },
        },
        "500": {
          description: "服务器内部错误。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } },
                },
              },
            },
          },
        },
      } as any,
    },
  },
);

/** 删除 Provider */
app.delete(
  "/config/providers/:name",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext!;
    try {
      return await handleDelete(authCtx, params.name);
    } catch (e: unknown) {
      if (e instanceof AppError) return error(e.statusCode, configError(e.code, e.message));
      return error(500, configError("CONFIG_WRITE_ERROR", e instanceof Error ? e.message : "Unknown error"));
    }
  },
  {
    sessionAuth: true,
    params: "provider-name-param" as any,
    detail: {
      tags: ["ProviderConfig"],
      summary: "删除 Provider",
      description:
        "删除指定的 Provider 及其下的所有模型。外部共享 Provider 不可删除。\n\n200 成功响应: data — null\n403 无权限 / 404 不存在 / 500 内部错误",
      responses: {
        "200": {
          description: "删除成功。data: null。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { success: { type: "boolean", const: true }, data: { type: "null" } },
              },
            },
          },
        },
        "403": {
          description: "无权限操作，外部共享资源不可写。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } },
                },
              },
            },
          },
        },
        "404": {
          description: "资源不存在。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } },
                },
              },
            },
          },
        },
        "500": {
          description: "服务器内部错误。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } },
                },
              },
            },
          },
        },
      } as any,
    },
  },
);

/** 测试 Provider 连接 */
app.post(
  "/config/providers/:name/test",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ store, params, body, error }: any) => {
    const authCtx = store.authContext!;
    const b = body ?? {};
    try {
      const protocol =
        b.protocol === "anthropic" ? ("anthropic" as const) : b.protocol === "openai" ? ("openai" as const) : undefined;
      return await handleTest(authCtx, params.name, { apiKey: b.apiKey, baseURL: b.baseURL, protocol });
    } catch (e: unknown) {
      if (e instanceof AppError) return error(e.statusCode, configError(e.code, e.message));
      return error(500, configError("CONFIG_READ_ERROR", e instanceof Error ? e.message : "Unknown error"));
    }
  },
  {
    sessionAuth: true,
    params: "provider-name-param" as any,
    detail: {
      tags: ["ProviderConfig"],
      summary: "测试 Provider 连接",
      description:
        "测试指定 Provider 的连接有效性。通过调用 Provider 的 models 列表 API 验证凭据和可达性，返回可用的模型 ID 列表。\n\n200 成功响应: data.models[] — 从 API 获取的可用模型 ID 列表\n400 参数错误 / 404 不存在 / 500 内部错误",
      responses: {
        "200": {
          description: "测试结果。data.models: 可用模型 ID 列表。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: true },
                  data: {
                    type: "object",
                    properties: {
                      models: { type: "array", items: { type: "string" }, description: "可用模型 ID 列表" },
                    },
                  },
                },
              },
            },
          },
        },
        "400": {
          description: "请求参数错误。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } },
                },
              },
            },
          },
        },
        "404": {
          description: "资源不存在。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } },
                },
              },
            },
          },
        },
        "500": {
          description: "服务器内部错误。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } },
                },
              },
            },
          },
        },
      } as any,
    },
  },
);

/** 添加 Provider 下的模型 */
app.post(
  "/config/providers/:name/models",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ store, params, body, error }: any) => {
    const authCtx = store.authContext!;
    try {
      return await handleAddModel(authCtx, params.name, body ?? {});
    } catch (e: unknown) {
      if (e instanceof AppError) return error(e.statusCode, configError(e.code, e.message));
      return error(500, configError("CONFIG_WRITE_ERROR", e instanceof Error ? e.message : "Unknown error"));
    }
  },
  {
    sessionAuth: true,
    params: "provider-name-param" as any,
    detail: {
      tags: ["ProviderConfig"],
      summary: "添加 Provider 下的模型",
      description:
        "向指定 Provider 添加一个新模型。请求体需提供 modelId 和可选的展示名称、limit 限制和 cost 费用配置。\n\n200 成功响应: data.modelId — 模型 ID\n400 参数错误 / 404 Provider 不存在 / 500 内部错误",
      responses: {
        "200": {
          description: "操作成功。data.modelId: 模型 ID。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: true },
                  data: { type: "object", properties: { modelId: { type: "string", description: "模型 ID" } } },
                },
              },
            },
          },
        },
        "400": {
          description: "请求参数错误。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } },
                },
              },
            },
          },
        },
        "404": {
          description: "资源不存在。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } },
                },
              },
            },
          },
        },
        "500": {
          description: "服务器内部错误。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } },
                },
              },
            },
          },
        },
      } as any,
    },
  },
);

/** 更新 Provider 下的模型 */
app.put(
  "/config/providers/:name/models/:modelId",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ store, params, body, error }: any) => {
    const authCtx = store.authContext!;
    try {
      return await handleUpdateModel(authCtx, params.name, params.modelId, body ?? {});
    } catch (e: unknown) {
      if (e instanceof AppError) return error(e.statusCode, configError(e.code, e.message));
      return error(500, configError("CONFIG_WRITE_ERROR", e instanceof Error ? e.message : "Unknown error"));
    }
  },
  {
    sessionAuth: true,
    params: "provider-name-modelid-params" as any,
    detail: {
      tags: ["ProviderConfig"],
      summary: "更新 Provider 下的模型",
      description:
        "更新指定 Provider 下某个模型的配置。支持修改模型名称、上下文限制、输出限制和费用信息。\n\n200 成功响应: data.modelId — 模型 ID\n400 参数错误 / 404 不存在 / 500 内部错误",
      responses: {
        "200": {
          description: "操作成功。data.modelId: 模型 ID。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: true },
                  data: { type: "object", properties: { modelId: { type: "string", description: "模型 ID" } } },
                },
              },
            },
          },
        },
        "400": {
          description: "请求参数错误。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } },
                },
              },
            },
          },
        },
        "404": {
          description: "资源不存在。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } },
                },
              },
            },
          },
        },
        "500": {
          description: "服务器内部错误。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } },
                },
              },
            },
          },
        },
      } as any,
    },
  },
);

/** 删除 Provider 下的模型 */
app.delete(
  "/config/providers/:name/models/:modelId",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext!;
    try {
      return await handleRemoveModel(authCtx, params.name, params.modelId);
    } catch (e: unknown) {
      if (e instanceof AppError) return error(e.statusCode, configError(e.code, e.message));
      return error(500, configError("CONFIG_WRITE_ERROR", e instanceof Error ? e.message : "Unknown error"));
    }
  },
  {
    sessionAuth: true,
    params: "provider-name-modelid-params" as any,
    detail: {
      tags: ["ProviderConfig"],
      summary: "删除 Provider 下的模型",
      description: "删除指定 Provider 下的某个模型。\n\n200 成功响应: data — null\n404 不存在 / 500 内部错误",
      responses: {
        "200": {
          description: "删除成功。data: null。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { success: { type: "boolean", const: true }, data: { type: "null" } },
              },
            },
          },
        },
        "400": {
          description: "请求参数错误。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } },
                },
              },
            },
          },
        },
        "403": {
          description: "无权限操作，外部共享资源不可写。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } },
                },
              },
            },
          },
        },
        "404": {
          description: "资源不存在。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } },
                },
              },
            },
          },
        },
        "500": {
          description: "服务器内部错误。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } },
                },
              },
            },
          },
        },
      } as any,
    },
  },
);

/** 测试 Provider 下某个模型的对话能力 */
app.post(
  "/config/providers/:name/models/:modelId/test",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext!;
    try {
      return await handleTestModel(authCtx, params.name, params.modelId);
    } catch (e: unknown) {
      if (e instanceof AppError) return error(e.statusCode, configError(e.code, e.message));
      return error(500, configError("CONFIG_READ_ERROR", e instanceof Error ? e.message : "Unknown error"));
    }
  },
  {
    sessionAuth: true,
    params: "provider-name-modelid-params" as any,
    detail: {
      tags: ["ProviderConfig"],
      summary: "测试模型对话能力",
      description:
        "测试指定模型的实际对话生成能力。向 Provider 发送测试消息并返回模型响应的文本内容。\n\n200 成功响应: data — 包含 ok(bool) 和 content(string)\n400 参数错误 / 404 不存在 / 500 内部错误",
      responses: {
        "200": {
          description: "测试结果。data: ok, content。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: true },
                  data: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean", description: "测试是否成功" },
                      content: { type: "string", description: "模型返回的文本内容" },
                    },
                  },
                },
              },
            },
          },
        },
        "400": {
          description: "请求参数错误。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } },
                },
              },
            },
          },
        },
        "404": {
          description: "资源不存在。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } },
                },
              },
            },
          },
        },
        "500": {
          description: "服务器内部错误。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: false },
                  error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } },
                },
              },
            },
          },
        },
      } as any,
    },
  },
);

export default app;
