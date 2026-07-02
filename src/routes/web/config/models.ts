import Elysia from "elysia";
import * as z from "zod/v4";
import { AppError } from "../../../errors";
import { type AuthContext, authGuardPlugin } from "../../../plugins/auth";
import { WebErrSchema, WebOkSchema } from "../../../schemas/common.schema";
import {
  type ConfigBody,
  ConfigBodySchema,
  ModelPreferencesBodySchema,
  ModelPreferencesResponseSchema,
  ModelRefreshResponseSchema,
} from "../../../schemas/config.schema";
import * as configPg from "../../../services/config/index";
import { configError, configSuccess } from "../../../services/config-utils";

const app = new Elysia({ name: "web-config-models" }).use(authGuardPlugin).model({
  "config-body": ConfigBodySchema,
  "model-preferences-body": ModelPreferencesBodySchema,
  "model-preferences-response": ModelPreferencesResponseSchema,
  "model-refresh-response": ModelRefreshResponseSchema,
});

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

/** 可用模型缓存（按 organizationId 隔离） */
const cachedAvailableByOrg = new Map<
  string,
  {
    models: Array<{
      id: string;
      modelId: string;
      displayName: string;
      provider: string;
      providerDisplayName: string;
      contextLimit: number | null;
      outputLimit: number | null;
      providerResourceAccess?: import("../../../services/config/types").ResourceAccess;
      providerResourceKey?: string;
    }>;
    updatedAt: number;
  }
>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟

type ModelEntry = {
  id: string;
  modelId: string;
  displayName: string;
  provider: string;
  providerDisplayName: string;
  contextLimit: number | null;
  outputLimit: number | null;
  providerResourceAccess?: import("../../../services/config/types").ResourceAccess;
  providerResourceKey?: string;
};

async function buildAvailableList(ctx: AuthContext): Promise<ModelEntry[]> {
  const providers = await configPg.listProviders(ctx);
  const models: ModelEntry[] = [];
  for (const p of providers) {
    const providerResourceKey = p.resourceAccess?.resourceKey ?? p.resourceKey;
    const pDetail = await configPg.getProvider(ctx, providerResourceKey ?? p.name);
    if (!pDetail?.models) continue;
    const providerDisplayName = p.displayName ?? p.name;
    for (const m of pDetail.models) {
      const limit = (m.limitConfig as { context?: number; output?: number } | undefined) ?? undefined;
      const inheritedAccess = m.providerResourceAccess ?? p.resourceAccess;
      const modelDisplayName = m.displayName ?? m.modelId;
      models.push({
        // Agent config now persists modelId as the model table UUID, while
        // current model preferences still save provider/model string refs.
        id: m.id,
        modelId: m.modelId,
        displayName: modelDisplayName,
        provider: p.name,
        providerDisplayName,
        contextLimit: limit?.context ?? null,
        outputLimit: limit?.output ?? null,
        providerResourceAccess: inheritedAccess,
        providerResourceKey,
      });
    }
  }
  return models;
}

async function assertReadableModelRef(ctx: AuthContext, ref: string) {
  const parts = ref.split("/");
  const providerDetail =
    parts.length >= 3
      ? await configPg.getProviderByResourceKey(ctx, `${parts[0]}/${parts[1]}`)
      : parts.length === 2
        ? await configPg.getProvider(ctx, parts[0])
        : null;
  if (!providerDetail) {
    return configError("VALIDATION_ERROR", `Model provider for '${ref}' is not readable`);
  }

  const modelId = parts.length >= 3 ? parts.slice(2).join("/") : parts[1];
  const exists = providerDetail.models?.some((model) => model.modelId === modelId);
  if (!exists) {
    return configError("VALIDATION_ERROR", `Model '${ref}' is not available`);
  }

  return null;
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
  if (data.model) {
    const err = await assertReadableModelRef(ctx, data.model);
    if (err) return err;
  }
  if (data.small_model) {
    const err = await assertReadableModelRef(ctx, data.small_model);
    if (err) return err;
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

// ── 新 RESTful 路由（注册在旧 POST action 分发路由之前，保持向后兼容）──

/** GET /config/models：获取可用模型列表与用户偏好 */
app.get(
  "/config/models",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, status }: any) => {
    const authCtx = store.authContext!;
    try {
      return await handleGet(authCtx);
    } catch (e: unknown) {
      if (e instanceof AppError) {
        return status(e.statusCode, configError(e.code, e.message));
      }
      const message = e instanceof Error ? e.message : "Unknown error";
      return status(500, configError("CONFIG_READ_ERROR", message));
    }
  },
  {
    sessionAuth: true,
    response: {
      200: WebOkSchema(z.looseObject({})),
      400: WebErrSchema,
      403: WebErrSchema,
      500: WebErrSchema,
    },
    detail: {
      tags: ["ModelConfig"],
      summary: "获取可用模型列表与用户偏好",
      description:
        "返回当前用户可用的所有模型列表（按 provider 分组）以及用户的当前模型偏好设置，包括主模型、轻量模型和权限配置。",
    },
  },
);

/** PUT /config/models：更新用户模型偏好 */
app.put(
  "/config/models",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth + body model
  async ({ store, body, status }: any) => {
    const authCtx = store.authContext!;
    const data = body as { model?: string; small_model?: string; permission?: unknown };
    try {
      const result = await handleSet(authCtx, data);
      if (result && typeof result === "object" && "success" in result && result.success === false) {
        return status(configErrorStatus(result.error?.code), result);
      }
      return result;
    } catch (e: unknown) {
      if (e instanceof AppError) {
        return status(e.statusCode, configError(e.code, e.message));
      }
      const message = e instanceof Error ? e.message : "Unknown error";
      return status(500, configError("CONFIG_WRITE_ERROR", message));
    }
  },
  {
    sessionAuth: true,
    body: "model-preferences-body",
    response: {
      200: WebOkSchema(z.looseObject({})),
      400: WebErrSchema,
      403: WebErrSchema,
      500: WebErrSchema,
    },
    detail: {
      tags: ["ModelConfig"],
      summary: "更新用户模型偏好",
      description: "更新当前用户的主模型、轻量模型和权限偏好。至少提供一个字段。模型引用格式为 provider/modelId。",
    },
  },
);

/** POST /config/models/refresh：强制刷新可用模型缓存 */
app.post(
  "/config/models/refresh",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, status }: any) => {
    const authCtx = store.authContext!;
    try {
      return await handleRefresh(authCtx);
    } catch (e: unknown) {
      if (e instanceof AppError) {
        return status(e.statusCode, configError(e.code, e.message));
      }
      const message = e instanceof Error ? e.message : "Unknown error";
      return status(500, configError("CONFIG_READ_ERROR", message));
    }
  },
  {
    sessionAuth: true,
    response: {
      200: WebOkSchema(z.looseObject({})),
      400: WebErrSchema,
      403: WebErrSchema,
      500: WebErrSchema,
    },
    detail: {
      tags: ["ModelConfig"],
      summary: "强制刷新可用模型缓存",
      description: "强制刷新当前组织的可用模型缓存，绕过 5 分钟 TTL，从 provider 实时拉取最新模型列表。",
    },
  },
);

// ── 旧 POST action 分发路由（保持向后兼容）──

app.post(
  "/config/models",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth + body model
  async ({ store, body, status }: any) => {
    const authCtx = store.authContext!;
    const b = (body as ConfigBody) ?? {};
    const payload = {
      action: b.action ?? "",
      data: b.data as { model?: string; small_model?: string; permission?: unknown } | undefined,
    };
    try {
      const result = await (async () => {
        switch (payload.action) {
          case "get":
            return await handleGet(authCtx);
          case "set":
            return await handleSet(authCtx, payload.data ?? {});
          case "refresh":
            return await handleRefresh(authCtx);
          default:
            return status(400, configError("VALIDATION_ERROR", `Unknown action: ${payload.action}`));
        }
      })();

      if (result && typeof result === "object" && "success" in result && result.success === false) {
        return status(configErrorStatus(result.error?.code), result);
      }

      return result;
    } catch (e: unknown) {
      if (e instanceof AppError) {
        return status(e.statusCode, configError(e.code, e.message));
      }
      const message = e instanceof Error ? e.message : "Unknown error";
      return status(500, configError("CONFIG_READ_ERROR", message));
    }
  },
  {
    sessionAuth: true,
    body: "config-body",
    response: {
      // TODO: 当前仍是 action 分发入口，成功 data 先以宽松 object|null 占位；后续应拆分为独立接口并补精确成功响应 schema。
      200: WebOkSchema(z.union([z.looseObject({}), z.null()])),
      400: WebErrSchema,
      403: WebErrSchema,
      404: WebErrSchema,
      409: WebErrSchema,
      500: WebErrSchema,
    },
    detail: { tags: ["ModelConfig"], summary: "Model 配置管理（旧 action 分发入口）" },
  },
);

export default app;
