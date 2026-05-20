import Elysia from "elysia";
import { type AuthContext, authGuardPlugin } from "../../../plugins/auth";
import { type ConfigBody, ConfigBodySchema } from "../../../schemas/config.schema";
import { buildModelData } from "../../../services/config/provider";
import * as configPg from "../../../services/config-pg";
import { configError, configSuccess, resolveApiKey, toKeyHint } from "../../../services/config-utils";
import { invalidateAvailableCache } from "./models";

type ProviderBody = { action: string; name?: string; modelId?: string; data?: Record<string, unknown> };

const app = new Elysia({ name: "web-config-providers", prefix: "/web" }).use(authGuardPlugin).model({
  "config-body": ConfigBodySchema,
});

async function handleList(ctx: AuthContext) {
  const providers = await configPg.listProviders(ctx);
  const list = providers.map((p) => ({
    id: p.name,
    name: p.name,
    npm: p.npm ?? null,
    configured: !!p.apiKey,
    keyHint: toKeyHint(p.apiKey),
    baseURL: p.baseUrl ?? null,
    modelCount: p.modelCount,
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
  }));

  return configSuccess({
    id: name,
    name: p.name,
    npm: p.npm ?? null,
    keyHint: toKeyHint(p.apiKey),
    baseURL: p.baseUrl ?? null,
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

  // 分解 data 为 PG 字段
  const apiKey = data.apiKey as string | undefined;
  const baseUrl = data.baseURL as string | undefined;
  const npm = (data.npm as string) ?? existing?.npm ?? "@ai-sdk/openai-compatible";
  const displayName = (data.name as string) ?? existing?.displayName ?? undefined;

  // 收集 extraOptions：data 中除已知字段外的其他 options
  const knownKeys = new Set(["npm", "name", "baseURL", "apiKey", "models", "options"]);
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

  await configPg.upsertProvider(ctx, name, {
    displayName,
    npm,
    baseUrl,
    apiKey,
    extraOptions: Object.keys(extraOptions).length > 0 ? extraOptions : undefined,
  });

  // 处理 models（如果有）
  if (data.models && typeof data.models === "object") {
    const providerRecord = await configPg.getProvider(ctx, name);
    if (providerRecord) {
      const incoming = data.models as Record<string, Record<string, unknown>>;
      for (const [modelId, modelCfg] of Object.entries(incoming)) {
        const existingModel = providerRecord.models?.find((m) => m.modelId === modelId);
        if (existingModel) {
          await configPg.updateModel(providerRecord.id, modelId, buildModelData(modelCfg));
        } else {
          await configPg.addModel(providerRecord.id, { modelId, ...buildModelData(modelCfg) });
        }
      }
    }
  }

  invalidateAvailableCache();
  return configSuccess({ id: name, keyHint: toKeyHint(apiKey ?? existing?.apiKey) });
}

async function handleTest(ctx: AuthContext, name: string) {
  const p = await configPg.getProvider(ctx, name);
  if (!p) return configError("NOT_FOUND", `Provider '${name}' not found`);

  const apiKey = resolveApiKey(p.apiKey) ?? "";
  const baseURL = p.baseUrl ?? "https://api.anthropic.com";

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const modelsPath = baseURL.endsWith("/v1") ? "/models" : "/v1/models";
    const res = await fetch(`${baseURL}${modelsPath}`, {
      headers: { Authorization: `Bearer ${apiKey}`, "x-api-key": apiKey },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        let detail = "";
        try {
          const body = await res.text();
          detail = body.slice(0, 200);
        } catch {}
        return configError("CONFIG_READ_ERROR", `认证失败 (HTTP ${res.status})${detail ? ": " + detail : ""}`);
      }
      return configSuccess({ models: [], warning: `API 可达，但模型列表接口返回 HTTP ${res.status}` });
    }
    const json = (await res.json()) as { data?: Array<{ id: string }> };
    const models = (json.data ?? []).map((m) => m.id);
    return configSuccess({ models });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Connection failed";
    return configError("CONFIG_READ_ERROR", `Test failed: ${message}`);
  }
}

async function handleDelete(ctx: AuthContext, name: string) {
  const deleted = await configPg.deleteProvider(ctx, name);
  if (!deleted) return configError("NOT_FOUND", `Provider '${name}' not found`);
  invalidateAvailableCache();
  return configSuccess(null);
}

async function handleAddModel(ctx: AuthContext, providerName: string, data: Record<string, unknown>) {
  const modelId = data.modelId as string;
  if (!modelId) return configError("VALIDATION_ERROR", "modelId is required");

  const p = await configPg.getProvider(ctx, providerName);
  if (!p) return configError("NOT_FOUND", `Provider '${providerName}' not found`);

  const existingModel = p.models?.find((m) => m.modelId === modelId);
  if (existingModel) return configError("VALIDATION_ERROR", `Model '${modelId}' already exists`);

  await configPg.addModel(p.id, { modelId, ...buildModelData(data) });
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

  const p = await configPg.getProvider(ctx, providerName);
  if (!p) return configError("NOT_FOUND", `Provider '${providerName}' not found`);

  const existingModel = p.models?.find((m) => m.modelId === modelId);
  if (!existingModel) return configError("NOT_FOUND", `Model '${modelId}' not found`);

  await configPg.updateModel(p.id, modelId, buildModelData(data));
  invalidateAvailableCache();
  return configSuccess({ modelId });
}

async function handleRemoveModel(ctx: AuthContext, providerName: string, modelId: string) {
  if (!modelId) return configError("VALIDATION_ERROR", "modelId is required");

  const p = await configPg.getProvider(ctx, providerName);
  if (!p) return configError("NOT_FOUND", `Provider '${providerName}' not found`);

  const existingModel = p.models?.find((m) => m.modelId === modelId);
  if (!existingModel) return configError("NOT_FOUND", `Model '${modelId}' not found`);

  await configPg.removeModel(p.id, modelId);
  invalidateAvailableCache();
  return configSuccess(null);
}

app.post(
  "/config/providers",
  async ({ store, body, error, request }: any) => {
    const authCtx = store.authContext!;
    const b = body as ConfigBody;
    const payload: ProviderBody = { action: b.action ?? "", name: b.name, modelId: b.modelId, data: b.data };
    try {
      switch (payload.action) {
        case "list":
          return await handleList(authCtx);
        case "get":
          return await handleGet(authCtx, payload.name!);
        case "set":
          return await handleSet(authCtx, payload.name!, payload.data!);
        case "test":
          return await handleTest(authCtx, payload.name!);
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
      const message = e instanceof Error ? e.message : "Unknown error";
      return error(500, configError("CONFIG_READ_ERROR", message));
    }
  },
  { sessionAuth: true, body: "config-body", detail: { tags: ["Config"], summary: "Provider 配置管理" } },
);

export default app;
