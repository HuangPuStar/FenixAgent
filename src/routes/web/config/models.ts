import Elysia from "elysia";
import { authGuardPlugin } from "../../../plugins/auth";
import * as configPg from "../../../services/config-pg";

const app = new Elysia({ name: "web-config-models", prefix: "/web" })
  .use(authGuardPlugin);

/** 可用模型缓存 */
let cachedAvailable: { models: Array<{ id: string; provider: string; fullId: string; label: string; contextLimit: number | null; outputLimit: number | null }>; updatedAt: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟

function ok(data: unknown) { return { success: true as const, data }; }
function err(code: string, message: string) { return { success: false as const, error: { code, message } }; }

type ModelEntry = { id: string; provider: string; fullId: string; label: string; contextLimit: number | null; outputLimit: number | null };

async function buildAvailableList(userId: string): Promise<ModelEntry[]> {
  const providers = await configPg.listProviders(userId);
  const models: ModelEntry[] = [];
  for (const p of providers) {
    const pDetail = await configPg.getProvider(userId, p.name);
    if (!pDetail?.models) continue;
    for (const m of pDetail.models) {
      const limit = (m.limitConfig as { context?: number; output?: number } | undefined) ?? undefined;
      models.push({
        id: m.modelId,
        provider: p.name,
        fullId: `${p.name}/${m.modelId}`,
        label: m.displayName ?? m.modelId,
        contextLimit: limit?.context ?? null,
        outputLimit: limit?.output ?? null,
      });
    }
  }
  return models;
}

async function getAvailable(userId: string, forceRefresh = false): Promise<ModelEntry[]> {
  const now = Date.now();
  if (!forceRefresh && cachedAvailable && (now - cachedAvailable.updatedAt) < CACHE_TTL_MS) {
    return cachedAvailable.models;
  }
  const models = await buildAvailableList(userId);
  cachedAvailable = { models, updatedAt: now };
  return models;
}

async function handleGet(userId: string) {
  const uc = await configPg.getUserConfig(userId);
  const available = await getAvailable(userId);
  return ok({
    current: {
      model: uc.currentModel ?? null,
      small_model: uc.smallModel ?? null,
      permission: uc.permission ?? null,
    },
    available,
  });
}

async function handleSet(userId: string, data: { model?: string; small_model?: string; permission?: unknown }) {
  if (!data.model && !data.small_model && data.permission === undefined) {
    return err("VALIDATION_ERROR", "At least one of 'model', 'small_model', or 'permission' is required");
  }
  await configPg.setUserConfig(userId, {
    currentModel: data.model,
    smallModel: data.small_model,
    permission: data.permission,
  });
  cachedAvailable = null;
  const uc = await configPg.getUserConfig(userId);
  return ok({
    model: uc.currentModel ?? null,
    small_model: uc.smallModel ?? null,
    permission: uc.permission ?? null,
  });
}

export function invalidateAvailableCache() {
  cachedAvailable = null;
}

async function handleRefresh(userId: string) {
  const available = await getAvailable(userId, true);
  return ok({ count: available.length });
}

app.post("/config/models", async ({ store, body, error }) => {
  const user = store.user!;
  const b = (body as any) ?? {};
  const payload = { action: b.action ?? "", data: b.data as { model?: string; small_model?: string; permission?: unknown } | undefined };
  try {
    switch (payload.action) {
      case "get": return await handleGet(user.id);
      case "set": return await handleSet(user.id, payload.data ?? {});
      case "refresh": return await handleRefresh(user.id);
      default: return error(400, err("VALIDATION_ERROR", `Unknown action: ${payload.action}`));
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return error(500, err("CONFIG_READ_ERROR", message));
  }
}, { sessionAuth: true });

export default app;
