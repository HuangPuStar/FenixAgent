/**
 * `/web/config/models` — 用户模型偏好与可用模型列表。
 *
 * 三条路由：
 *
 *   GET  /config/models          → 当前偏好 + 该用户可见的可用模型列表
 *   PUT  /config/models          → 更新当前偏好（模型引用必须先校验可读）
 *   POST /config/models/refresh  → 强制重建可用模型缓存
 *
 * 可用列表由 `buildAvailableList` 从 Provider 列表 + 逐条详情拼出，因此按 `(organizationId, userId)`
 * 缓存 5 分钟；Provider 与 Model 的写路径主动失效。缓存本体在
 * `../../../services/available-models-cache`，与 `/web/config/providers` 共享。
 */

import { type ActorContext, WebErrSchema, WebOkSchema } from "@fenix/platform-sdk";
import { ValidationError } from "@server/errors";
import { authGuardPlugin } from "@server/plugins/auth";
import {
  ModelPreferencesBodySchema,
  ModelPreferencesResponseSchema,
  ModelRefreshResponseSchema,
} from "@server/schemas/config.schema";
import type { PermissionConfig } from "@server/services/config/types";
import { getUserConfig, setUserConfig } from "@server/services/config/user-config";
import { configError, configSuccess } from "@server/services/config-utils";
import Elysia from "elysia";
import * as z from "zod/v4";
import { getModelManagementModule } from "../../../module-runtime";
import {
  type AvailableModelEntry,
  deleteAvailableModelsCache,
  readAvailableModelsCache,
  writeAvailableModelsCache,
} from "../../../services/available-models-cache";
import { safeWebHandler } from "./web-envelope";

const app = new Elysia({ name: "web-config-models" }).use(authGuardPlugin).model({
  "model-preferences-body": ModelPreferencesBodySchema,
  "model-preferences-response": ModelPreferencesResponseSchema,
  "model-refresh-response": ModelRefreshResponseSchema,
});

/**
 * 用户偏好与可用模型缓存都按组织隔离。
 *
 * `/web` 请求经 `authGuardPlugin` 后必然带 active organization（`toActorContext` 直接取
 * `AuthContext.organizationId`），缺失只可能是装配错误，因此显式报错而不是回落到某个默认组织。
 */
function organizationIdOf(actor: ActorContext): string {
  const organizationId = actor.activeOrganizationId;
  if (organizationId === undefined) throw new ValidationError("缺少组织上下文");
  return organizationId;
}

/** 用户配置的读取主体；经 {@link organizationIdOf} 校验后组织必然存在。 */
function subjectOf(actor: ActorContext): { organizationId: string; userId: string } {
  return { organizationId: organizationIdOf(actor), userId: actor.userId };
}

/**
 * 拼出当前主体可见的模型列表。
 *
 * 逐 Provider 取详情补 `models`（列表项不含子表），因此整体结果按主体缓存。`scope` / `access` 取
 * Provider 的：模型没有自己的归属与动作集合（决策 D6）。
 *
 * `organizationName` 只为跨组织可见的 Provider 解析：它是来源标记，本组织资源加前缀只会让每行的标签
 * 都重复当前组织名（迁移前 `sourceOrganizationName` 的语义正是如此）。
 */
async function buildAvailableList(actor: ActorContext): Promise<AvailableModelEntry[]> {
  const { facade, identity } = getModelManagementModule();
  const { items } = await facade.list(actor);
  const activeOrganizationId = actor.activeOrganizationId;

  const externalOrganizationIds = [
    ...new Set(
      items
        .map((item) => item.scope.organizationId)
        .filter((id): id is string => typeof id === "string" && id !== activeOrganizationId),
    ),
  ];
  const organizationNames =
    externalOrganizationIds.length > 0 ? await identity.listOrganizationNames(externalOrganizationIds) : new Map();

  const models: AvailableModelEntry[] = [];
  for (const item of items) {
    const detail = await facade.getById(actor, item.id);
    if (!detail) continue;
    const providerDisplayName = item.displayName ?? item.name;
    const organizationName = organizationNames.get(item.scope.organizationId ?? "");
    for (const model of detail.models) {
      const limit = model.limitConfig as { context?: number; output?: number } | null | undefined;
      models.push({
        id: model.id,
        modelId: model.modelId,
        displayName: model.displayName ?? model.modelId,
        provider: item.name,
        providerId: item.id,
        providerDisplayName,
        contextLimit: limit?.context ?? null,
        outputLimit: limit?.output ?? null,
        modalities: model.modalities ?? undefined,
        scope: detail.scope,
        access: detail.access,
        ...(organizationName === undefined ? {} : { organizationName }),
      });
    }
  }
  return models;
}

/**
 * 校验偏好里引用的模型可读。
 *
 * 引用有两种历史形式：`provider/modelId`（当前偏好保存的形式）与 `orgId/providerId/modelId`（Agent
 * 配置保存的形式）。前者按名称定位 Provider，后者按资源键定位；两条路径都由 Facade 做可见性判定，
 * 因此这里不区分"不存在"与"不可见"——对调用方都是同一个"不可用"结论。
 */
async function assertReadableModelRef(actor: ActorContext, ref: string) {
  const parts = ref.split("/");
  const providerRef = parts.length >= 3 ? `${parts[0]}/${parts[1]}` : parts.length === 2 ? parts[0] : undefined;
  if (providerRef === undefined) {
    return configError("VALIDATION_ERROR", `Model provider for '${ref}' is not readable`);
  }

  const detail = await getModelManagementModule().facade.get(actor, providerRef);
  if (!detail) {
    return configError("VALIDATION_ERROR", `Model provider for '${ref}' is not readable`);
  }

  const modelId = parts.length >= 3 ? parts.slice(2).join("/") : parts[1];
  if (!detail.models.some((model) => model.modelId === modelId)) {
    return configError("VALIDATION_ERROR", `Model '${ref}' is not available`);
  }

  return null;
}

async function getAvailable(actor: ActorContext, forceRefresh = false): Promise<readonly AvailableModelEntry[]> {
  const subject = subjectOf(actor);
  const now = Date.now();
  const cached = readAvailableModelsCache(subject, forceRefresh, now);
  if (cached) return cached;

  const models = await buildAvailableList(actor);
  writeAvailableModelsCache(subject, models, now);
  return models;
}

async function handleGet(actor: ActorContext) {
  const userConfig = await getUserConfig(subjectOf(actor));
  const available = await getAvailable(actor);
  return configSuccess({
    current: {
      model: userConfig.currentModel ?? null,
      small_model: userConfig.smallModel ?? null,
      permission: userConfig.permission ?? null,
    },
    available,
  });
}

async function handleSet(actor: ActorContext, data: { model?: string; small_model?: string; permission?: unknown }) {
  if (!data.model && !data.small_model && data.permission === undefined) {
    return configError("VALIDATION_ERROR", "At least one of 'model', 'small_model', or 'permission' is required");
  }
  if (data.model) {
    const error = await assertReadableModelRef(actor, data.model);
    if (error) return error;
  }
  if (data.small_model) {
    const error = await assertReadableModelRef(actor, data.small_model);
    if (error) return error;
  }

  await setUserConfig(subjectOf(actor), {
    currentModel: data.model,
    smallModel: data.small_model,
    permission: data.permission as PermissionConfig | null,
  });
  deleteAvailableModelsCache(subjectOf(actor));

  const userConfig = await getUserConfig(subjectOf(actor));
  return configSuccess({
    model: userConfig.currentModel ?? null,
    small_model: userConfig.smallModel ?? null,
    permission: userConfig.permission ?? null,
  });
}

async function handleRefresh(actor: ActorContext) {
  const available = await getAvailable(actor, true);
  return configSuccess({ count: available.length });
}

// ── RESTful 路由 ──

/** GET /config/models：获取可用模型列表与用户偏好 */
app.get(
  "/config/models",
  safeWebHandler(async (_ctx, actor) => handleGet(actor), { fallbackCode: "CONFIG_READ_ERROR" }),
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
  safeWebHandler(
    async (ctx, actor) => handleSet(actor, ctx.body as { model?: string; small_model?: string; permission?: unknown }),
    { fallbackCode: "CONFIG_WRITE_ERROR" },
  ),
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
  safeWebHandler(async (_ctx, actor) => handleRefresh(actor), { fallbackCode: "CONFIG_READ_ERROR" }),
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
      description: "强制刷新当前用户在本组织的可用模型缓存，绕过 5 分钟 TTL，从 provider 实时拉取最新模型列表。",
    },
  },
);

export default app;
