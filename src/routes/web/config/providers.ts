import Elysia from "elysia";
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
});

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
    options: {
      ...(p.baseUrl ? { baseURL: p.baseUrl } : {}),
      ...(p.apiKey ? { apiKey: p.apiKey } : {}),
      ...(typeof p.extraOptions === "object" && p.extraOptions !== null
        ? (p.extraOptions as Record<string, unknown>)
        : {}),
    },
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

/**
 * 规范化 provider base URL，避免尾部 `/` 导致路径重复拼接。
 */
function normalizeProviderBaseUrl(baseUrl: string | null | undefined, protocol: "openai" | "anthropic"): string {
  const fallback = protocol === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com";
  return (baseUrl ?? fallback).replace(/\/+$/, "");
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
    baseURL = inline.baseURL ? normalizeProviderBaseUrl(inline.baseURL, inline.protocol ?? "openai") : "";
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

app.post(
  "/config/providers",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth + body model
  async ({ store, body, error }: any) => {
    const authCtx = store.authContext!;
    const b = body as ConfigBody;
    const payload: ProviderBody = {
      action: b.action ?? "",
      name: b.name,
      modelId: b.modelId,
      data: b.data,
      apiKey: b.apiKey,
      baseURL: b.baseURL,
      protocol: b.protocol,
    };
    try {
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
          return error(400, configError("VALIDATION_ERROR", `Unknown action: ${payload.action}`));
      }
    } catch (e: unknown) {
      if (e instanceof AppError) {
        return error(e.statusCode, configError(e.code, e.message));
      }
      const message = e instanceof Error ? e.message : "Unknown error";
      return error(500, configError("CONFIG_READ_ERROR", message));
    }
  },
  { sessionAuth: true, body: "config-body", detail: { tags: ["Config"], summary: "Provider 配置管理" } },
);

export default app;
