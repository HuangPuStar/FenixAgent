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

/**
 * 内联只改了 Base URL 时（面板的 Key 输入框写着"留空表示不修改"，编辑态留空是常态），用库中凭据补齐。
 *
 * 这正是缺陷现场：内联 baseURL 非空就进内联分支，key 为空便发出 `Authorization: Bearer `，于是探测
 * 打到用户刚填的新地址却没有凭据——无鉴权的自建端点能过，需要鉴权的上游必然 401。
 *
 * **只在同源时回退**：凭据按来源（scheme + host + port）授权，跨来源复用等于把库中密钥交给另一个主机。
 * 回退还要求调用方对该 Provider 有 `update` 动作，与落库分支走同一条授权路径。
 *
 * 返回 `null` 一律表示**不回退**，调用方保持内联分支原有的空凭据行为：授权不通过、Provider 不在库中、
 * 库中没存 baseURL、两端不同源、库中凭据解析不出来、任何异常，都归到这一条。探测的可用性不该因为
 * "顺手补一把钥匙"失败而变成 500 或 403。
 */
async function resolveSameOriginStoredApiKey(
  actor: ActorContext,
  name: string,
  inlineBaseUrl: string,
  resolveSecretReference: SecretReferenceResolver,
): Promise<string | null> {
  try {
    // 与落库分支同一入口、同一强度：`getForProbe` 要求 `update` 动作（探测会拿库中密钥打上游，按
    // "配置管理"而不是"只读查看"授权）。不可见返回 `undefined`，只读共享抛 `ForbiddenError`，两者都
    // 在下面的 catch 里归为不回退——回退失败不改变本请求原有的空凭据行为。
    const detail = await getModelManagementModule().facade.getForProbe(actor, { by: "nameOrKey", value: name });
    if (!detail?.baseUrl) return null;
    if (!isSameOrigin(inlineBaseUrl, detail.baseUrl)) return null;

    const apiKey = resolveProbeApiKey(detail.apiKey, resolveSecretReference);
    if (apiKey === null || apiKey === "") return null;
    return apiKey;
  } catch {
    return null;
  }
}

/**
 * 列出上游模型。
 *
 * 内联凭据分支（面板"先测后存"）不读库也不鉴权：Provider 尚未落库，没有资源可授权，凭据由请求方
 * 自带。落库分支要求 Provider 的 `update` 动作。两条分支的凭据都过 `resolveProbeApiKey`，所以
 * `{env:NAME}` 引用在"测"与"存"两侧行为一致。
 *
 * 内联分支的**同源回退**（本轮新增，修"改了 Base URL、Key 留空"的编辑态 401）：内联带了 baseURL 却
 * 没带 apiKey 时，尝试取库中凭据，取用条件见 {@link resolveSameOriginStoredApiKey}——同源 + 对该
 * Provider 有 `update` 动作，两条都满足才用，否则原样走空凭据。内联同时给了 baseURL 与 apiKey、或只给
 * apiKey、或 Provider 不在库中（新建场景）时，分支选择与凭据来源都与改动前完全一致。内联的
 * `protocol` 也就是回退时的 protocol：目标端点由内联 baseURL 决定，请求形态（Bearer / x-api-key）
 * 必须跟着它走。
 *
 * **SSRF 原语（迁移前既有，本次改动未放大）**：内联分支允许任一已认证用户让服务器带任意 apiKey 请求
 * 任意 URL，非 2xx 时响应体会被截取 200 字符回显——这是一个 SSRF 读取原语。修复需要出站 URL 策略
 * （内网地址黑名单 / 允许列表），超出任务 1.2 范围，记入 review 文档待单独处置。
 *
 * 同源回退不改变这个原语的形状：**目标 host 仍然只由内联 baseURL 决定**，回退只换"用哪把凭据"，而
 * 换了凭据的那条路径要求目标与库中已存端点同源、且调用方对该 Provider 有 `update` 动作——即落库分支
 * 早已允许的"用库中密钥打库中端点"，没有新增可达主机，也没有把凭据送去库中端点以外的来源。
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
    const apiKey = resolveProbeApiKey(inlineApiKey, resolveSecretReference);
    if (apiKey === null) return credentialUnresolvedError({ target: "provider", protocol: inlineProtocol });
    // 只在内联"给了地址、没给凭据"这一种组合下考虑回退；其余组合的凭据来源与改动前一致。
    const inheritedApiKey =
      inlineApiKey === "" && inlineBaseUrl !== ""
        ? await resolveSameOriginStoredApiKey(actor, name, inlineBaseUrl, resolveSecretReference)
        : null;
    target = {
      apiKey: inheritedApiKey ?? apiKey,
      baseUrl: normalizeProviderBaseUrl(inlineBaseUrl, inlineProtocol),
      protocol: inlineProtocol,
    };
  } else {
    const detail = await getModelManagementModule().facade.getForProbe(actor, { by: "nameOrKey", value: name });
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
  modelId: string,
  resolveSecretReference: SecretReferenceResolver,
) {
  if (!modelId) return configError("VALIDATION_ERROR", "modelId is required");

  const detail = await getModelManagementModule().facade.getForProbe(actor, { by: "nameOrKey", value: name });
  if (!detail) return configError("NOT_FOUND", `Provider '${name}' not found`);
  if (!detail.models.some((model) => model.modelId === modelId)) {
    return configError("NOT_FOUND", `Model '${modelId}' not found`);
  }

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
