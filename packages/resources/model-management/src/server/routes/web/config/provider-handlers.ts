import type { ActorContext } from "@fenix/platform-sdk";
import type { SecretReferenceResolver } from "../../../config-envelope";
import { configError, configSuccess, toKeyHint } from "../../../config-envelope";
import type { ProviderRef } from "../../../facades/provider-facade";
import { getModelManagementModule } from "../../../module-runtime";
import { invalidateAvailableModelsCache } from "../../../services/available-models-cache";
import { modelWriteDataFromWebConfig } from "../../../services/model-write-data";
import {
  fetchProviderModels,
  normalizeProviderBaseUrl,
  type ProviderProbeTarget,
  probeWithTimeout,
  testModelMessage,
} from "./provider-probe";
import { toWebProviderDetail, toWebProviderListItem } from "./provider-views";

/**
 * `/web/config/providers` 的 9 个 handler。
 *
 * 每个 handler 的形状都是"参数校验 → Facade → 视图投影"：授权判断、系统托管拒绝、归属解析全部在
 * Facade 里完成，这里不出现 `kind === "gateway"`、`writable` 或组织比较。错误码与文案保持迁移前
 * 逐字一致（`VALIDATION_ERROR` / `NOT_FOUND` / `FORBIDDEN`），因为它们是对外协议的一部分。
 *
 * `invalidateAvailableModelsCache()` 出现在每个写路径之后：可用模型列表是跨路由共享的按主体缓存，
 * 且写路径无法预知哪些主体会受影响，因此整体清空，见 `../../../services/available-models-cache`。
 *
 * 需要 `resolveSecretReference` 的 5 个 handler 把它作为末位参数收下（列表 / 详情 / 保存的 `keyHint`，
 * 探测两个入口的库中凭据）：密钥引用解析落在宿主一侧，包内不得读 `process.env`（1.3 硬条件 4），
 * 注入点见 `../../dependencies`。
 */

/** 探测类 handler 的内联凭据参数；配置面板用它实现"先测后存"。 */
export interface InlineProbeCredentials {
  readonly apiKey?: string;
  readonly baseURL?: string;
  readonly protocol?: "openai" | "anthropic";
}

export async function handleProviderList(actor: ActorContext, resolveSecretReference: SecretReferenceResolver) {
  const { items } = await getModelManagementModule().facade.list(actor);
  return configSuccess({ providers: items.map((item) => toWebProviderListItem(item, resolveSecretReference)) });
}

export async function handleProviderGet(
  actor: ActorContext,
  name: string,
  resolveSecretReference: SecretReferenceResolver,
) {
  const detail = await getModelManagementModule().facade.get(actor, name);
  if (!detail) return configError("NOT_FOUND", `Provider '${name}' not found`);
  return configSuccess(toWebProviderDetail(detail, name, resolveSecretReference));
}

/**
 * `PUT ?name=` 的幂等保存：存在则更新，不存在则创建。
 *
 * `name` 的非空保证由路由的 `requireName` 给出（缺参在协议层就返回 400），因此这里不再重复校验。
 *
 * `data` 的字段分解规则迁移前逐字保留：`name` 是**展示名**（配置名走 query 参数），已知字段之外
 * 的顶层键与 `options` 里除 `apiKey`/`baseURL` 之外的键都并入 `extraOptions`。`displayName` 与
 * `protocol` 用 `!== undefined` 判断而不是 `??` 链，否则 `existing.displayName` 为 `null` 时会被
 * 吞成"未提供"。
 */
export async function handleProviderSet(
  actor: ActorContext,
  name: string,
  data: Record<string, unknown>,
  resolveSecretReference: SecretReferenceResolver,
) {
  const { facade } = getModelManagementModule();
  // 读取现有配置只为保留未提交的字段；不存在时按"新建"取值，与迁移前一致。
  const existing = await facade.get(actor, name);

  const rawProtocol = data.protocol;
  const protocol =
    rawProtocol === "anthropic" || rawProtocol === "openai" ? rawProtocol : (existing?.protocol ?? "openai");
  const displayName =
    (data.name as string | undefined) !== undefined ? (data.name as string) : (existing?.displayName ?? null);
  const publicReadable = typeof data.publicReadable === "boolean" ? data.publicReadable : undefined;
  const apiKey = data.apiKey as string | undefined;
  const baseUrl = data.baseURL as string | undefined;

  const knownKeys = new Set(["protocol", "name", "baseURL", "apiKey", "models", "options", "publicReadable"]);
  const extraOptions: Record<string, unknown> = {};
  if (typeof data.options === "object" && data.options !== null) {
    for (const [key, value] of Object.entries(data.options as Record<string, unknown>)) {
      if (key !== "apiKey" && key !== "baseURL") extraOptions[key] = value;
    }
  }
  for (const [key, value] of Object.entries(data)) {
    if (!knownKeys.has(key)) extraOptions[key] = value;
  }

  const detail = await facade.save(
    actor,
    name,
    {
      displayName,
      protocol,
      baseUrl,
      apiKey,
      extraOptions: Object.keys(extraOptions).length > 0 ? extraOptions : undefined,
    },
    publicReadable === undefined ? {} : { publicReadable },
  );

  // 随配置一并提交的模型清单：逐条按 `modelId` upsert。子表写入需要 Provider 的 `update` 动作，
  // 不可写时 Facade 会直接拒绝——迁移前这里静默跳过，会让"提交成功但模型没保存"看起来像成功。
  if (data.models && typeof data.models === "object") {
    const ref: ProviderRef = { by: "nameOrKey", value: name };
    const existingModelIds = new Set(detail.models.map((model) => model.modelId));
    for (const [modelId, modelConfig] of Object.entries(data.models as Record<string, Record<string, unknown>>)) {
      const modelData = modelWriteDataFromWebConfig(modelConfig);
      if (existingModelIds.has(modelId)) {
        await facade.updateModel(actor, ref, { by: "modelId", value: modelId }, modelData);
      } else {
        await facade.addModel(actor, ref, modelId, modelData);
      }
    }
  }

  invalidateAvailableModelsCache();
  return configSuccess({
    id: name,
    name: displayName,
    protocol,
    keyHint: toKeyHint(apiKey ?? existing?.apiKey, resolveSecretReference),
  });
}

export async function handleProviderDelete(actor: ActorContext, name: string) {
  await getModelManagementModule().facade.remove(actor, { by: "nameOrKey", value: name });
  invalidateAvailableModelsCache();
  return configSuccess(null);
}

/**
 * 列出上游模型。
 *
 * 内联凭据分支（面板"先测后存"）不读库也不鉴权：Provider 尚未落库，没有资源可授权，凭据由请求方
 * 自带。落库分支要求 Provider 的 `update` 动作。
 *
 * **已知缺陷（迁移前既有，本切片保持行为并记录）**：内联分支允许任一已认证用户让服务器带任意
 * apiKey 请求任意 URL，非 2xx 时响应体会被截取 200 字符回显——这是一个 SSRF 读取原语。修复需要
 * 出站 URL 策略（内网地址黑名单 / 允许列表），超出任务 1.2 范围，待单独处置。
 */
export async function handleFetchModels(
  actor: ActorContext,
  name: string,
  inline: InlineProbeCredentials | undefined,
  resolveSecretReference: SecretReferenceResolver,
) {
  const inlineApiKey = typeof inline?.apiKey === "string" ? inline.apiKey : "";
  const inlineBaseUrl = typeof inline?.baseURL === "string" ? inline.baseURL : "";
  const inlineProtocol = inline?.protocol === "anthropic" ? "anthropic" : "openai";

  let target: ProviderProbeTarget;
  if (inlineApiKey !== "" || inlineBaseUrl !== "") {
    target = {
      apiKey: inlineApiKey,
      baseUrl: normalizeProviderBaseUrl(inlineBaseUrl, inlineProtocol),
      protocol: inlineProtocol,
    };
  } else {
    const detail = await getModelManagementModule().facade.getForProbe(actor, { by: "nameOrKey", value: name });
    if (!detail) return configError("NOT_FOUND", `Provider '${name}' not found`);
    target = {
      apiKey: resolveSecretReference(detail.apiKey) ?? "",
      baseUrl: normalizeProviderBaseUrl(detail.baseUrl, detail.protocol),
      protocol: detail.protocol,
    };
  }

  return probeWithTimeout(10_000, { target: "provider", protocol: target.protocol }, (signal) =>
    fetchProviderModels(target, signal),
  );
}

export async function handleTestModel(
  actor: ActorContext,
  name: string,
  modelId: string,
  resolveSecretReference: SecretReferenceResolver,
) {
  if (!modelId) return configError("VALIDATION_ERROR", "modelId is required");

  const detail = await getModelManagementModule().facade.getForProbe(actor, { by: "nameOrKey", value: name });
  if (!detail) return configError("NOT_FOUND", `Provider '${name}' not found`);
  if (!detail.models.some((model) => model.modelId === modelId)) {
    return configError("NOT_FOUND", `Model '${modelId}' not found`);
  }

  const target = {
    apiKey: resolveSecretReference(detail.apiKey) ?? "",
    baseUrl: normalizeProviderBaseUrl(detail.baseUrl, detail.protocol),
    protocol: detail.protocol,
    modelId,
  };

  return probeWithTimeout(15_000, { target: "model", protocol: target.protocol, modelId }, (signal) =>
    testModelMessage(target, signal),
  );
}

export async function handleAddModel(actor: ActorContext, providerName: string, data: Record<string, unknown>) {
  const modelId = data.modelId as string;
  if (!modelId) return configError("VALIDATION_ERROR", "modelId is required");

  const detail = await requireProviderForModelWrite(actor, providerName);
  if (detail.models.some((model) => model.modelId === modelId)) {
    return configError("VALIDATION_ERROR", `Model '${modelId}' already exists`);
  }

  await getModelManagementModule().facade.addModel(
    actor,
    { by: "nameOrKey", value: providerName },
    modelId,
    modelWriteDataFromWebConfig(data),
  );
  invalidateAvailableModelsCache();
  return configSuccess({ modelId });
}

export async function handleUpdateModel(
  actor: ActorContext,
  providerName: string,
  modelId: string,
  data: Record<string, unknown>,
) {
  if (!modelId) return configError("VALIDATION_ERROR", "modelId is required");

  const detail = await requireProviderForModelWrite(actor, providerName);
  if (!detail.models.some((model) => model.modelId === modelId)) {
    return configError("NOT_FOUND", `Model '${modelId}' not found`);
  }

  await getModelManagementModule().facade.updateModel(
    actor,
    { by: "nameOrKey", value: providerName },
    { by: "modelId", value: modelId },
    modelWriteDataFromWebConfig(data),
  );
  invalidateAvailableModelsCache();
  return configSuccess({ modelId });
}

export async function handleRemoveModel(actor: ActorContext, providerName: string, modelId: string) {
  if (!modelId) return configError("VALIDATION_ERROR", "modelId is required");

  const detail = await requireProviderForModelWrite(actor, providerName);
  if (!detail.models.some((model) => model.modelId === modelId)) {
    return configError("NOT_FOUND", `Model '${modelId}' not found`);
  }

  await getModelManagementModule().facade.removeModel(
    actor,
    { by: "nameOrKey", value: providerName },
    { by: "modelId", value: modelId },
  );
  invalidateAvailableModelsCache();
  return configSuccess({ modelId });
}

/** 三个子表写 handler 的公共前置；抛出的 `NotFoundError` / `ForbiddenError` 由信封统一转换。 */
async function requireProviderForModelWrite(actor: ActorContext, providerName: string) {
  return getModelManagementModule().facade.getWritable(actor, { by: "nameOrKey", value: providerName });
}
