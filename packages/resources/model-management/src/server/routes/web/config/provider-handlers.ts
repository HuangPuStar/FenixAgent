import type { ActorContext } from "@fenix/platform-sdk";
import type { SecretReferenceResolver } from "../../../config-envelope";
import { configError, configSuccess, toKeyHint } from "../../../config-envelope";
import type { ProviderRef } from "../../../facades/provider-facade";
import { getModelManagementModule } from "../../../module-runtime";
import { invalidateAvailableModelsCache } from "../../../services/available-models-cache";
import { modelWriteDataFromWebConfig } from "../../../services/model-write-data";
import {
  credentialUnresolvedError,
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
 * 探测两个入口的凭据——内联与库中各一条路径）：密钥引用解析落在宿主一侧，包内不得读 `process.env`
 * （1.3 硬条件 4），注入点见 `../../dependencies`。
 *
 * `fetch-models` 的内联分支在两个入口之外还有一条**同源回退**：内联给了新 Base URL、但没给 Key 时，
 * 库中同一来源（scheme + host + port）的凭据才是用户期望的那把。判定与授权见
 * {@link resolveSameOriginStoredApiKey}。
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
  const detail = await getModelManagementModule().facade.getById(actor, name);
  if (!detail) return configError("NOT_FOUND", `Provider '${name}' not found`);
  return configSuccess(toWebProviderDetail(detail, resolveSecretReference));
}

/** 创建与按 ID 更新共用字段投影，缺省字段保持原值。 */
export async function handleProviderSet(
  actor: ActorContext,
  name: string,
  data: Record<string, unknown>,
  resolveSecretReference: SecretReferenceResolver,
  creating = false,
) {
  const { facade } = getModelManagementModule();
  // 更新只保留目标行的缺省字段；失效 ID 不得转为创建。
  const existing = creating ? undefined : await facade.getById(actor, name);
  if (!creating && !existing) return configError("NOT_FOUND", `Provider '${name}' not found`);

  const rawProtocol = data.protocol;
  const protocol =
    rawProtocol === "anthropic" || rawProtocol === "openai" ? rawProtocol : (existing?.protocol ?? "openai");
  const displayName =
    (data.displayName as string | undefined) !== undefined
      ? (data.displayName as string)
      : (existing?.displayName ?? null);
  const publicReadable = typeof data.publicReadable === "boolean" ? data.publicReadable : undefined;
  const apiKey = data.apiKey as string | undefined;
  const baseUrl = data.baseURL as string | undefined;

  const knownKeys = new Set([
    "protocol",
    "name",
    "displayName",
    "baseURL",
    "apiKey",
    "models",
    "options",
    "publicReadable",
  ]);
  const extraOptions: Record<string, unknown> = {};
  if (typeof data.options === "object" && data.options !== null) {
    for (const [key, value] of Object.entries(data.options as Record<string, unknown>)) {
      if (key !== "apiKey" && key !== "baseURL") extraOptions[key] = value;
    }
  }
  for (const [key, value] of Object.entries(data)) {
    if (!knownKeys.has(key)) extraOptions[key] = value;
  }

  const detail = await (creating ? facade.create.bind(facade) : facade.saveById.bind(facade))(
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
    const ref: ProviderRef = { by: "resourceId", value: detail.id };
    const existingModelIds = new Set(detail.models.map((model) => model.modelId));
    for (const [modelId, modelConfig] of Object.entries(data.models as Record<string, Record<string, unknown>>)) {
      const modelData = modelWriteDataFromWebConfig(modelConfig);
      if (existingModelIds.has(modelId)) {
        await facade.updateModel(
          actor,
          ref,
          { by: "id", value: detail.models.find((model) => model.modelId === modelId)!.id },
          modelData,
        );
      } else {
        await facade.addModel(actor, ref, modelId, modelData);
      }
    }
  }

  invalidateAvailableModelsCache();
  return configSuccess({
    id: detail.id,
    name: detail.name,
    displayName: detail.displayName,
    protocol,
    keyHint: toKeyHint(apiKey ?? existing?.apiKey, resolveSecretReference),
  });
}

export async function handleProviderDelete(actor: ActorContext, name: string) {
  await getModelManagementModule().facade.remove(actor, { by: "resourceId", value: name });
  invalidateAvailableModelsCache();
  return configSuccess(null);
}

/**
 * 解析探测凭据：`null` 表示**引用无法解析**，`""` 表示**本来就没有配置凭据**。
 *
 * 两者必须分开：无凭据的端点（本地推理服务之类）带空 `Authorization` 是既有且必要的行为；而
 * `{env:NAME}` 引用未配置时同样被压成空字符串，就会发出 `Authorization: Bearer `，用户在上游拿到的
 * 是 401——"先测后存"因此看起来像功能坏了。
 *
 * 判据取"原文非空 + 解析结果为空"：按 `SecretReferenceResolver` 的约定，非空明文必然解析回自身，所以
 * 这个组合只可能来自解析不出的引用，包内不必复制宿主的 `{env:...}` 引用语法。
 */
function resolveProbeApiKey(
  raw: string | undefined | null,
  resolveSecretReference: SecretReferenceResolver,
): string | null {
  const resolved = resolveSecretReference(raw);
  if (resolved !== null) return resolved;
  return raw ? null : "";
}

/** 已识别 scheme 的默认端口；`URL` 通常已把默认端口归一成空串，这张表让意图不依赖解析器的隐式行为。 */
const DEFAULT_PORTS: Record<string, string | undefined> = { "http:": "80", "https:": "443" };

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    // 相对地址、空串、拼错的 scheme 都落在这里：判不出来就不算同源。
    return null;
  }
}

function effectivePort(url: URL): string {
  return url.port !== "" ? url.port : (DEFAULT_PORTS[url.protocol] ?? "");
}

/**
 * 两个 baseURL 是否**同源**：scheme + host + port 全等；`candidate` 是请求带来的地址，`stored` 是库中
 * 的端点。
 *
 * 必须走 `URL` 解析后逐项比较，不能拿原文字符串做前缀/子串判断：`https://gw.example.com.attacker.net`
 * 以 `https://gw.example.com` 为前缀，`https://gw.example.com@evil.example.net` 把真 host 藏在 userinfo
 * 之后——两种都会让"看起来是同源"的字符串判真，而请求实际打到攻击者主机上。解析后的 `hostname` 还顺带
 * 归一了大小写与 IDN，并让 `https://gw.example.com:443` 与 `https://gw.example.com` 等价（见
 * {@link effectivePort}）。
 *
 * 路径不参与比较：同 ORIGIN 下换路径（`/v1` → `/v2`）本就是本回退要支持的场景。
 */
function isSameOrigin(candidate: string, stored: string): boolean {
  const candidateUrl = parseUrl(candidate);
  const storedUrl = parseUrl(stored);
  if (!candidateUrl || !storedUrl) return false;
  return (
    candidateUrl.protocol === storedUrl.protocol &&
    candidateUrl.hostname === storedUrl.hostname &&
    effectivePort(candidateUrl) === effectivePort(storedUrl)
  );
}

/** 草稿仅使用显式凭据；已有配置先授权，同源时才补齐库中凭据。 */
export async function handleFetchModels(
  actor: ActorContext,
  name: string | undefined,
  inline: InlineProbeCredentials | undefined,
  resolveSecretReference: SecretReferenceResolver,
) {
  const stored =
    name === undefined
      ? undefined
      : await getModelManagementModule().facade.getForProbe(actor, { by: "resourceId", value: name });
  if (name !== undefined && !stored) return configError("NOT_FOUND", `Provider '${name}' not found`);
  const inlineApiKey = typeof inline?.apiKey === "string" ? inline.apiKey : "";
  const inlineBaseUrl = typeof inline?.baseURL === "string" ? inline.baseURL : "";
  const inlineProtocol = inline?.protocol === "anthropic" ? "anthropic" : "openai";

  let target: ProviderProbeTarget;
  if (inlineApiKey !== "" || inlineBaseUrl !== "") {
    const apiKey = resolveProbeApiKey(inlineApiKey, resolveSecretReference);
    if (apiKey === null) return credentialUnresolvedError({ target: "provider", protocol: inlineProtocol });
    // 只在内联"给了地址、没给凭据"这一种组合下考虑回退；其余组合的凭据来源与改动前一致。
    const inheritedApiKey =
      stored?.baseUrl && inlineApiKey === "" && isSameOrigin(inlineBaseUrl, stored.baseUrl)
        ? resolveProbeApiKey(stored.apiKey, resolveSecretReference)
        : null;
    target = {
      apiKey: inheritedApiKey ?? apiKey,
      baseUrl: normalizeProviderBaseUrl(inlineBaseUrl, inlineProtocol),
      protocol: inlineProtocol,
    };
  } else {
    if (!name) return configError("VALIDATION_ERROR", "Inline baseURL is required");
    const detail = stored;
    if (!detail) return configError("NOT_FOUND", `Provider '${name}' not found`);
    const apiKey = resolveProbeApiKey(detail.apiKey, resolveSecretReference);
    if (apiKey === null) return credentialUnresolvedError({ target: "provider", protocol: detail.protocol });
    target = {
      apiKey,
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
  modelResourceId: string,
  resolveSecretReference: SecretReferenceResolver,
) {
  if (!modelResourceId) return configError("VALIDATION_ERROR", "id is required");

  const detail = await getModelManagementModule().facade.getForProbe(actor, { by: "resourceId", value: name });
  if (!detail) return configError("NOT_FOUND", `Provider '${name}' not found`);
  const selectedModel = detail.models.find((model) => model.id === modelResourceId);
  if (!selectedModel) return configError("NOT_FOUND", `Model '${modelResourceId}' not found`);
  const modelId = selectedModel.modelId;

  const apiKey = resolveProbeApiKey(detail.apiKey, resolveSecretReference);
  if (apiKey === null) {
    return credentialUnresolvedError({ target: "model", protocol: detail.protocol, modelId });
  }

  const target = {
    apiKey,
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

  const result = await getModelManagementModule().facade.addModel(
    actor,
    { by: "resourceId", value: providerName },
    modelId,
    modelWriteDataFromWebConfig(data),
  );
  invalidateAvailableModelsCache();
  return configSuccess({ id: result.id, modelId });
}

export async function handleUpdateModel(
  actor: ActorContext,
  providerName: string,
  modelId: string,
  data: Record<string, unknown>,
) {
  if (!modelId) return configError("VALIDATION_ERROR", "modelId is required");

  const detail = await requireProviderForModelWrite(actor, providerName);
  if (!detail.models.some((model) => model.id === modelId)) {
    return configError("NOT_FOUND", `Model '${modelId}' not found`);
  }

  const result = await getModelManagementModule().facade.updateModel(
    actor,
    { by: "resourceId", value: providerName },
    { by: "id", value: modelId },
    modelWriteDataFromWebConfig(data),
  );
  invalidateAvailableModelsCache();
  return configSuccess({ id: modelId, modelId: result.modelId });
}

export async function handleRemoveModel(actor: ActorContext, providerName: string, modelId: string) {
  if (!modelId) return configError("VALIDATION_ERROR", "modelId is required");

  const detail = await requireProviderForModelWrite(actor, providerName);
  if (!detail.models.some((model) => model.id === modelId)) {
    return configError("NOT_FOUND", `Model '${modelId}' not found`);
  }

  const result = await getModelManagementModule().facade.removeModel(
    actor,
    { by: "resourceId", value: providerName },
    { by: "id", value: modelId },
  );
  invalidateAvailableModelsCache();
  return configSuccess({ id: modelId, modelId: result.modelId });
}

/** 三个子表写 handler 的公共前置；抛出的 `NotFoundError` / `ForbiddenError` 由信封统一转换。 */
async function requireProviderForModelWrite(actor: ActorContext, providerName: string) {
  return getModelManagementModule().facade.getWritable(actor, { by: "resourceId", value: providerName });
}
