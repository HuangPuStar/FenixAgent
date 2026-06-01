import Elysia from "elysia";
import { type AuthContext, authGuardPlugin } from "../../../plugins/auth";
import { type ConfigBody, ConfigBodySchema } from "../../../schemas/config.schema";
import * as configPg from "../../../services/config/index";
import { configError, configSuccess } from "../../../services/config-utils";

const app = new Elysia({ name: "web-config-models" }).use(authGuardPlugin).model({
  "config-body": ConfigBodySchema,
});

/** 可用模型缓存（按 organizationId 隔离） */
const cachedAvailableByOrg = new Map<
  string,
  {
    models: Array<{
      id: string;
      provider: string;
      fullId: string;
      label: string;
      contextLimit: number | null;
      outputLimit: number | null;
    }>;
    updatedAt: number;
  }
>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟

type ModelEntry = {
  id: string;
  provider: string;
  fullId: string;
  label: string;
  contextLimit: number | null;
  outputLimit: number | null;
};

async function buildAvailableList(ctx: AuthContext): Promise<ModelEntry[]> {
  const providers = await configPg.listProviders(ctx);
  const models: ModelEntry[] = [];
  for (const p of providers) {
    const pDetail = await configPg.getProvider(ctx, p.name);
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

async function getAvailable(ctx: AuthContext, forceRefresh = false): Promise<ModelEntry[]> {
  const now = Date.now();
  const cached = cachedAvailableByOrg.get(ctx.organizationId);
  if (!forceRefresh && cached && now - cached.updatedAt < CACHE_TTL_MS) {
    return cached.models;
  }
  const models = await buildAvailableList(ctx);
  cachedAvailableByOrg.set(ctx.organizationId, { models, updatedAt: now });
  return models;
}

async function handleGet(ctx: AuthContext) {
  const uc = await configPg.getUserConfig(ctx);
  const available = await getAvailable(ctx);
  return configSuccess({
    current: {
      model: uc.currentModel ?? null,
      small_model: uc.smallModel ?? null,
      permission: uc.permission ?? null,
    },
    available,
  });
}

async function handleSet(ctx: AuthContext, data: { model?: string; small_model?: string; permission?: unknown }) {
  if (!data.model && !data.small_model && data.permission === undefined) {
    return configError("VALIDATION_ERROR", "At least one of 'model', 'small_model', or 'permission' is required");
  }
  await configPg.setUserConfig(ctx, {
    currentModel: data.model,
    smallModel: data.small_model,
    permission: data.permission as import("../../../services/config/types").PermissionConfig | null,
  });
  cachedAvailableByOrg.delete(ctx.organizationId);
  const uc = await configPg.getUserConfig(ctx);
  return configSuccess({
    model: uc.currentModel ?? null,
    small_model: uc.smallModel ?? null,
    permission: uc.permission ?? null,
  });
}

export function invalidateAvailableCache() {
  cachedAvailableByOrg.clear();
}

async function handleRefresh(ctx: AuthContext) {
  const available = await getAvailable(ctx, true);
  return configSuccess({ count: available.length });
}

app.post(
  "/config/models",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth + body model
  async ({ store, body, error }: any) => {
    const authCtx = store.authContext!;
    const b = (body as ConfigBody) ?? {};
    const payload = {
      action: b.action ?? "",
      data: b.data as { model?: string; small_model?: string; permission?: unknown } | undefined,
    };
    try {
      switch (payload.action) {
        case "get":
          return await handleGet(authCtx);
        case "set":
          return await handleSet(authCtx, payload.data ?? {});
        case "refresh":
          return await handleRefresh(authCtx);
        default:
          return error(400, configError("VALIDATION_ERROR", `Unknown action: ${payload.action}`));
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Unknown error";
      return error(500, configError("CONFIG_READ_ERROR", message));
    }
  },
  { sessionAuth: true, body: "config-body", detail: { tags: ["Config"], summary: "Model 配置管理" } },
);

export default app;
