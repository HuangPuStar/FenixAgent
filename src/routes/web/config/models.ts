import Elysia from "elysia";
import * as z from "zod/v4";
import { AppError } from "../../../errors";
import { type AuthContext, authGuardPlugin } from "../../../plugins/auth";
import { type ConfigBody, ConfigBodySchema } from "../../../schemas/config.schema";
import * as configPg from "../../../services/config/index";
import { configError, configSuccess } from "../../../services/config-utils";

const app = new Elysia({ name: "web-config-models" }).use(authGuardPlugin).model({
  "config-body": ConfigBodySchema,
  "config-response": z
    .object({
      success: z.boolean().describe("接口调用是否成功。true 表示成功，false 表示失败。"),
      data: z.any().optional().describe("成功时的响应数据。"),
      error: z
        .object({
          code: z.string().describe("错误码。"),
          message: z.string().describe("错误描述信息。"),
        })
        .optional()
        .describe("失败时的错误信息。"),
    })
    .passthrough()
    .describe("Model 配置通用响应。"),
});

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

// ────────────────────────────────────────────
// Model 用户偏好管理（RESTful 接口）
// ────────────────────────────────────────────

/** 获取当前用户的模型偏好配置和可用模型列表 */
app.get(
  "/config/models",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store }: any) => {
    const authCtx = store.authContext!;
    try {
      return await handleGet(authCtx);
    } catch (e: unknown) {
      if (e instanceof AppError) return configError(e.code, e.message);
      return configError("CONFIG_READ_ERROR", e instanceof Error ? e.message : "Unknown error");
    }
  },
  {
    sessionAuth: true,
    detail: {
      tags: ["ModelConfig"],
      summary: "获取模型偏好与可用模型列表",
      description:
        "返回当前用户的模型偏好配置和所有可用的模型列表。\n\n200 成功响应: data — 包含 current (model, small_model, permission) 和 available[] (可用模型列表)\n400 参数错误 / 500 内部错误",
      responses: {
        "200": {
          description:
            "成功返回模型偏好和可用模型列表。data.current: model, small_model, permission。data.available[]: 可用模型列表。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: true },
                  data: {
                    type: "object",
                    properties: {
                      current: {
                        type: "object",
                        properties: {
                          model: { type: "string" },
                          small_model: { type: "string" },
                          permission: { type: "object" },
                        },
                      },
                      available: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            modelId: { type: "string" },
                            displayName: { type: "string" },
                            provider: { type: "string" },
                            providerDisplayName: { type: "string" },
                            contextLimit: { type: "number" },
                            outputLimit: { type: "number" },
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

/** 更新当前用户的模型偏好（current model、small model、permission） */
app.put(
  "/config/models",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ store, body, error }: any) => {
    const authCtx = store.authContext!;
    const b = (body ?? {}) as { model?: string; small_model?: string; permission?: unknown };
    try {
      return await handleSet(authCtx, b);
    } catch (e: unknown) {
      if (e instanceof AppError) return error(e.statusCode, configError(e.code, e.message));
      return error(500, configError("CONFIG_WRITE_ERROR", e instanceof Error ? e.message : "Unknown error"));
    }
  },
  {
    sessionAuth: true,
    detail: {
      tags: ["ModelConfig"],
      summary: "更新模型偏好",
      description:
        "更新当前用户的模型偏好设置，包括主模型（model）、轻量模型（small_model）和权限配置（permission）。请求体中只需包含需要更新的字段。\n\n200 成功响应: data — 包含 model, small_model, permission\n400 参数错误 / 500 内部错误",
      responses: {
        "200": {
          description: "更新成功。data: model, small_model, permission。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: true },
                  data: {
                    type: "object",
                    properties: {
                      model: { type: "string" },
                      small_model: { type: "string" },
                      permission: { type: "object" },
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

/** 刷新可用模型缓存 */
app.post(
  "/config/models/refresh",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store }: any) => {
    const authCtx = store.authContext!;
    try {
      return await handleRefresh(authCtx);
    } catch (e: unknown) {
      if (e instanceof AppError) return configError(e.code, e.message);
      return configError("CONFIG_READ_ERROR", e instanceof Error ? e.message : "Unknown error");
    }
  },
  {
    sessionAuth: true,
    detail: {
      tags: ["ModelConfig"],
      summary: "刷新可用模型缓存",
      description:
        "强制刷新可用模型列表的缓存。可用模型每 5 分钟自动刷新一次，调用此接口可立即更新缓存。\n\n200 成功响应: data.count — 可用模型数量\n500 内部错误",
      responses: {
        "200": {
          description: "刷新缓存成功。data.count: 可用模型数量。",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  success: { type: "boolean", const: true },
                  data: { type: "object", properties: { count: { type: "number", description: "可用模型数量" } } },
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
