import { Hono } from "hono";
import { sessionAuth } from "../../../auth/middleware";
import { getConfig, setTopLevelField } from "../../../services/config";

const app = new Hono();

/** 可用模型缓存：{ models, updatedAt } */
let cachedAvailable: { models: Array<{ id: string; provider: string; fullId: string; label: string; contextLimit: number | null; outputLimit: number | null }>; updatedAt: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟

function ok(data: unknown) { return { success: true as const, data }; }
function err(code: string, message: string) { return { success: false as const, error: { code, message } }; }

type ModelEntry = { id: string; provider: string; fullId: string; label: string; contextLimit: number | null; outputLimit: number | null };

async function buildAvailableList(): Promise<ModelEntry[]> {
  const config = await getConfig();
  const providers = (config.provider as Record<string, Record<string, unknown>>) ?? {};
  const models: ModelEntry[] = [];
  for (const [providerName, providerCfg] of Object.entries(providers)) {
    const providerModels = providerCfg.models as Record<string, Record<string, unknown>> | undefined;
    if (!providerModels) continue;
    for (const [modelId, modelCfg] of Object.entries(providerModels)) {
      const limit = modelCfg?.limit as { context?: number; output?: number } | undefined;
      models.push({
        id: modelId,
        provider: providerName,
        fullId: `${providerName}/${modelId}`,
        label: (modelCfg?.name as string) ?? modelId,
        contextLimit: limit?.context ?? null,
        outputLimit: limit?.output ?? null,
      });
    }
  }
  return models;
}

async function getAvailable(forceRefresh = false): Promise<ModelEntry[]> {
  const now = Date.now();
  if (!forceRefresh && cachedAvailable && (now - cachedAvailable.updatedAt) < CACHE_TTL_MS) {
    return cachedAvailable.models;
  }
  const models = await buildAvailableList();
  cachedAvailable = { models, updatedAt: now };
  return models;
}

async function handleGet() {
  const config = await getConfig();
  const available = await getAvailable();
  return ok({
    current: {
      model: (config.model as string) ?? null,
      small_model: (config.small_model as string) ?? null,
      permission: (config.permission as unknown) ?? null,
    },
    available,
  });
}

async function handleSet(data: { model?: string; small_model?: string; permission?: unknown }) {
  if (!data.model && !data.small_model && data.permission === undefined) {
    return err("VALIDATION_ERROR", "At least one of 'model', 'small_model', or 'permission' is required");
  }
  if (data.model) await setTopLevelField("model", data.model);
  if (data.small_model) await setTopLevelField("small_model", data.small_model);
  if (data.permission !== undefined) await setTopLevelField("permission", data.permission);
  // 读回确认
  const config = await getConfig();
  return ok({
    model: (config.model as string | null) ?? null,
    small_model: (config.small_model as string | null) ?? null,
    permission: (config.permission as unknown) ?? null,
  });
}

async function handleRefresh() {
  const available = await getAvailable(true);
  return ok({ count: available.length });
}

app.post("/config/models", sessionAuth, async (c) => {
  const body = await c.req.json<{ action: string; data?: { model?: string; small_model?: string; permission?: unknown } }>().catch((): { action: string; data?: { model?: string; small_model?: string; permission?: unknown } } => ({ action: "" }));
  try {
    switch (body.action) {
      case "get": return c.json(await handleGet());
      case "set": return c.json(await handleSet(body.data ?? {}));
      case "refresh": return c.json(await handleRefresh());
      default: return c.json(err("VALIDATION_ERROR", `Unknown action: ${body.action}`), 400);
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return c.json(err("CONFIG_READ_ERROR", message), 500);
  }
});

export default app;
