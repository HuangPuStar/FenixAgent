import { Hono } from "hono";
import { sessionAuth } from "../../../auth/middleware";
import { getSection, replaceSection } from "../../../services/config";

type ProviderConfig = {
  npm?: string;
  name?: string;
  options?: { apiKey?: string; baseURL?: string; [key: string]: unknown };
  models?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
};
type ProviderBody = { action: string; name?: string; modelId?: string; data?: Record<string, unknown> };

const app = new Hono();

/** 从 apiKey 字段生成 keyHint：取尾 4 位，前缀 *** */
function toKeyHint(apiKey: string | undefined): string | null {
  const realKey = resolveApiKey(apiKey);
  if (!realKey || realKey.length < 4) return null;
  return "***" + realKey.slice(-4);
}

/** 解析 apiKey：明文直接返回，{env:XXX} 引用尝试环境变量（兼容旧配置） */
function resolveApiKey(raw: string | undefined): string | null {
  if (!raw) return null;
  const envMatch = raw.match(/^\{env:(.+)\}$/);
  return envMatch ? (process.env[envMatch[1]] ?? null) : raw;
}

function ok(data: unknown) { return { success: true as const, data }; }
function err(code: string, message: string) { return { success: false as const, error: { code, message } }; }

function extractApiKey(cfg: ProviderConfig): string | undefined {
  return cfg.options?.apiKey as string | undefined;
}

function extractBaseURL(cfg: ProviderConfig): string | undefined {
  return cfg.options?.baseURL as string | undefined;
}

async function handleList() {
  const provider = (await getSection<Record<string, ProviderConfig>>("provider")) ?? {};
  const providers = Object.entries(provider).map(([id, cfg]) => ({
    id,
    name: cfg.name ?? id,
    npm: cfg.npm ?? null,
    configured: !!extractApiKey(cfg),
    keyHint: toKeyHint(extractApiKey(cfg)),
    baseURL: extractBaseURL(cfg) ?? null,
    modelCount: cfg.models ? Object.keys(cfg.models).length : 0,
  }));
  return ok({ providers });
}

async function handleGet(name: string) {
  const provider = (await getSection<Record<string, ProviderConfig>>("provider")) ?? {};
  const cfg = provider[name];
  if (!cfg) return err("NOT_FOUND", `Provider '${name}' not found`);
  const models = cfg.models
    ? Object.entries(cfg.models).map(([modelId, modelCfg]) => ({
        id: modelId,
        name: (modelCfg.name as string) ?? modelId,
        modalities: modelCfg.modalities ?? null,
        limit: modelCfg.limit ?? null,
        cost: modelCfg.cost ?? null,
      }))
    : [];
  return ok({
    id: name,
    name: cfg.name ?? name,
    npm: cfg.npm ?? null,
    keyHint: toKeyHint(extractApiKey(cfg)),
    baseURL: extractBaseURL(cfg) ?? null,
    options: cfg.options ?? {},
    models,
  });
}

async function handleSet(name: string, data: Record<string, unknown>) {
  if (!name || typeof name !== "string") return err("VALIDATION_ERROR", "Provider name is required");

  // 构造 opencode 标准嵌套结构
  const provider = (await getSection<Record<string, ProviderConfig>>("provider")) ?? {};
  const existing = provider[name] ?? {};

  // 将扁平的 data 映射到嵌套结构
  const updated: ProviderConfig = {
    ...existing,
    npm: (data.npm as string) ?? existing.npm ?? "@ai-sdk/openai-compatible",
    name: (data.name as string) ?? existing.name,
    options: {
      ...(existing.options ?? {}),
      ...(data.baseURL !== undefined ? { baseURL: data.baseURL as string } : {}),
      ...(data.apiKey !== undefined ? { apiKey: data.apiKey as string } : {}),
    },
  };
  // 保留已有 models
  if (existing.models) updated.models = existing.models;
  // 如果 data 中包含 models，更新
  if (data.models && typeof data.models === "object") {
    updated.models = data.models as Record<string, Record<string, unknown>>;
  }

  provider[name] = updated;
  await replaceSection("provider", provider);
  return ok({ id: name, keyHint: toKeyHint(updated.options?.apiKey as string | undefined) });
}

async function handleTest(name: string) {
  const provider = (await getSection<Record<string, ProviderConfig>>("provider")) ?? {};
  const cfg = provider[name];
  if (!cfg) return err("NOT_FOUND", `Provider '${name}' not found`);

  const apiKey = resolveApiKey(extractApiKey(cfg)) ?? "";
  let baseURL = extractBaseURL(cfg) ?? "https://api.anthropic.com";

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    // 避免双重 /v1：如果 baseURL 已以 /v1 结尾，不再追加
    const modelsPath = baseURL.endsWith("/v1") ? "/models" : "/v1/models";
    const res = await fetch(`${baseURL}${modelsPath}`, {
      headers: { "Authorization": `Bearer ${apiKey}`, "x-api-key": apiKey },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      // 401/403 → 认证失败
      if (res.status === 401 || res.status === 403) {
        let detail = "";
        try { const body = await res.text(); detail = body.slice(0, 200); } catch {}
        return err("CONFIG_READ_ERROR", `认证失败 (HTTP ${res.status})${detail ? ": " + detail : ""}`);
      }
      // 其他错误（400、404 等）→ API 可达，只是模型列表接口不兼容
      return ok({ models: [], warning: `API 可达，但模型列表接口返回 HTTP ${res.status}` });
    }
    const json = await res.json() as { data?: Array<{ id: string }> };
    const models = (json.data ?? []).map((m) => m.id);
    return ok({ models });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Connection failed";
    return err("CONFIG_READ_ERROR", `Test failed: ${message}`);
  }
}

async function handleDelete(name: string) {
  const provider = (await getSection<Record<string, ProviderConfig>>("provider")) ?? {};
  if (!provider[name]) return err("NOT_FOUND", `Provider '${name}' not found`);
  delete provider[name];
  await replaceSection("provider", provider);
  return ok(null);
}

async function handleAddModel(providerName: string, data: Record<string, unknown>) {
  const modelId = data.modelId as string;
  if (!modelId) return err("VALIDATION_ERROR", "modelId is required");

  const provider = (await getSection<Record<string, ProviderConfig>>("provider")) ?? {};
  const cfg = provider[providerName];
  if (!cfg) return err("NOT_FOUND", `Provider '${providerName}' not found`);

  if (!cfg.models) cfg.models = {};
  if (cfg.models[modelId]) return err("VALIDATION_ERROR", `Model '${modelId}' already exists`);

  cfg.models[modelId] = buildModelData(data);
  await replaceSection("provider", provider);
  return ok({ modelId });
}

async function handleUpdateModel(providerName: string, modelId: string, data: Record<string, unknown>) {
  if (!modelId) return err("VALIDATION_ERROR", "modelId is required");

  const provider = (await getSection<Record<string, ProviderConfig>>("provider")) ?? {};
  const cfg = provider[providerName];
  if (!cfg) return err("NOT_FOUND", `Provider '${providerName}' not found`);
  if (!cfg.models || !cfg.models[modelId]) return err("NOT_FOUND", `Model '${modelId}' not found`);

  const existing = cfg.models[modelId] as Record<string, unknown>;
  const incoming = buildModelData(data);
  const merged: Record<string, unknown> = { ...existing };
  for (const [k, v] of Object.entries(incoming)) {
    if (v && typeof v === "object" && !Array.isArray(v) && existing[k] && typeof existing[k] === "object" && !Array.isArray(existing[k])) {
      merged[k] = { ...(existing[k] as Record<string, unknown>), ...(v as Record<string, unknown>) };
    } else {
      merged[k] = v;
    }
  }
  cfg.models[modelId] = merged;
  await replaceSection("provider", provider);
  return ok({ modelId });
}

async function handleRemoveModel(providerName: string, modelId: string) {
  if (!modelId) return err("VALIDATION_ERROR", "modelId is required");

  const provider = (await getSection<Record<string, ProviderConfig>>("provider")) ?? {};
  const cfg = provider[providerName];
  if (!cfg) return err("NOT_FOUND", `Provider '${providerName}' not found`);
  if (!cfg.models || !cfg.models[modelId]) return err("NOT_FOUND", `Model '${modelId}' not found`);

  delete cfg.models[modelId];
  await replaceSection("provider", provider);
  return ok(null);
}

function buildModelData(data: Record<string, unknown>): Record<string, unknown> {
  const model: Record<string, unknown> = {};
  if (data.name) model.name = data.name;
  if (data.modalities) model.modalities = data.modalities;
  if (data.limit) model.limit = data.limit;
  if (data.cost) model.cost = data.cost;
  if (data.options) model.options = data.options;
  return model;
}

app.post("/config/providers", sessionAuth, async (c) => {
  const body = await c.req.json<ProviderBody>().catch((): ProviderBody => ({ action: "" }));
  try {
    switch (body.action) {
      case "list": return c.json(await handleList());
      case "get": return c.json(await handleGet(body.name!));
      case "set": return c.json(await handleSet(body.name!, body.data!));
      case "test": return c.json(await handleTest(body.name!));
      case "delete": return c.json(await handleDelete(body.name!));
      case "add_model": return c.json(await handleAddModel(body.name!, body.data!));
      case "update_model": return c.json(await handleUpdateModel(body.name!, body.modelId!, body.data!));
      case "remove_model": return c.json(await handleRemoveModel(body.name!, body.modelId!));
      default: return c.json(err("VALIDATION_ERROR", `Unknown action: ${body.action}`), 400);
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return c.json(err("CONFIG_READ_ERROR", message), 500);
  }
});

export default app;
