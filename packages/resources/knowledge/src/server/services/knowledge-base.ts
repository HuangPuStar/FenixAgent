import { randomBytes } from "node:crypto";
import type { KnowledgeBaseRow } from "../repositories/knowledge-base";
import { agentKnowledgeBindingRepo, knowledgeBaseRepo, knowledgeResourceRepo } from "../repositories/knowledge-base";
import type { KnowledgeBaseCredential } from "./knowledge-credential";
import { mergeKnowledgeBaseMetadata, readKnowledgeBaseMetadata } from "./knowledge-metadata";
import { getKnowledgeProvider } from "./knowledge-provider/registry";
import type {
  ChunkMethodOption,
  InstanceModelOption,
  KnowledgeBaseStatus,
  KnowledgeFormOptions,
  KnowledgeResourceStatus,
} from "./knowledge-provider/types";
import { resolveRagflowApiKey } from "./ragflow-key";

export interface KnowledgeTenantIdentity {
  remoteAccountId: string;
  remoteUserId: string;
}

/**
 * RagFlow v0.26 原生分块方法（chunk_method）枚举，对齐 RagFlow parser_ids 展示名。
 */
export const KNOWLEDGE_CHUNK_METHODS: ChunkMethodOption[] = [
  { value: "naive", label: "General" },
  { value: "book", label: "Book" },
  { value: "email", label: "Email" },
  { value: "laws", label: "Laws" },
  { value: "manual", label: "Manual" },
  { value: "one", label: "One" },
  { value: "paper", label: "Paper" },
  { value: "picture", label: "Picture" },
  { value: "presentation", label: "Presentation" },
  { value: "qa", label: "Q&A" },
  { value: "table", label: "Table" },
  { value: "tag", label: "Tag" },
  { value: "resume", label: "Resume" },
  { value: "audio", label: "Audio" },
];

function _generateKnowledgeBaseId(): string {
  return `kb_${randomBytes(8).toString("hex")}`;
}

/** 已配置实例节点：一对 (provider, instanceName) + 其下所有模型 */
export interface ConfiguredInstanceNode {
  provider: string;
  instanceName: string;
  status: string;
  models: InstanceModelOption[];
}

/** 已配置供应商节点：provider 名 + 其下所有实例 */
export interface ConfiguredProviderNode {
  provider: string;
  instances: ConfiguredInstanceNode[];
}

function normalizeSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

/**
 * 将任意名称裁剪为可读的 slug base。
 * 仅保留 ASCII 字母和数字，避免中文等名称直接进入 slug。
 */
function buildSlugBase(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * 基于知识库名称生成 slug。
 * 可读 base 为空时回退到 `kb-<suffix>`，附加随机后缀保证唯一性。
 */
export function generateKnowledgeBaseSlug(name: string): string {
  const suffix = randomBytes(4).toString("hex");
  const base = buildSlugBase(name);
  if (!base) {
    return `kb-${suffix}`;
  }
  const maxBaseLength = 80 - suffix.length - 1;
  const trimmedBase = base.slice(0, maxBaseLength).replace(/-+$/g, "");
  return `${trimmedBase || "kb"}-${suffix}`;
}

function validateName(name: string): string | null {
  if (!name || name.trim().length === 0) {
    return "知识库名称不能为空";
  }
  if (name.trim().length > 120) {
    return "知识库名称不能超过 120 字符";
  }
  return null;
}

function validateSlug(slug: string): string | null {
  const normalized = normalizeSlug(slug);
  if (!normalized) {
    return "slug 不能为空";
  }
  if (!/^[\p{L}0-9]([\p{L}0-9-]*[\p{L}0-9])?$/u.test(normalized)) {
    return "slug 只能包含字母、数字和连字符";
  }
  if (normalized.length > 80) {
    return "slug 不能超过 80 字符";
  }
  return null;
}

function _toUnixTimestamp(value: Date | null | undefined): number | null {
  return value ? Math.floor(value.getTime() / 1000) : null;
}

export { setKnowledgeProviderForTesting } from "./knowledge-provider/registry";

/**
 * 知识库的对外 DTO（列表项与详情同源）。
 *
 * 由 {@link sanitizeKnowledgeBase} 从资源行扁平化得到；两个协议入口（`/web` 控制台、`/api` 对外列表）
 * 都返回这个形状，字段集合由它以类型表达，避免多处手抄一份"看起来一样"的接口。
 */
export type KnowledgeBaseListItem = ReturnType<typeof sanitizeKnowledgeBase>;

export function sanitizeKnowledgeBase(
  row: KnowledgeBaseRow,
  extras?: {
    bindingsCount?: number;
    resourcesCount?: number;
    remoteExists?: boolean;
    recentResources?: Array<{
      id: string;
      sourceName: string;
      sourceType: string;
      status: KnowledgeResourceStatus;
      lastError: string | null;
      createdAt: number;
      updatedAt: number;
    }>;
  },
) {
  const metadata = readKnowledgeBaseMetadata(row.metadata);
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description ?? null,
    provider: row.provider,
    remoteId: row.remoteId ?? null,
    remoteAccountId: row.remoteAccountId ?? null,
    remoteUserId: row.remoteUserId ?? null,
    userId: row.userId,
    organizationId: row.organizationId ?? null,
    status: row.status as KnowledgeBaseStatus,
    lastError: row.lastError ?? null,
    // 创建时选定的 RagFlow 配置，回显给列表/详情
    embeddingModel: metadata.embeddingModel,
    parseMethod: metadata.parseMethod,
    chunkMethod: metadata.chunkMethod,
    bindingsCount: extras?.bindingsCount ?? 0,
    resourcesCount: extras?.resourcesCount ?? 0,
    remoteExists: extras?.remoteExists ?? true,
    recentResources: extras?.recentResources ?? [],
    createdAt: Math.floor(row.createdAt.getTime() / 1000),
    updatedAt: Math.floor(row.updatedAt.getTime() / 1000),
  };
}

export function resolveKnowledgeTenantIdentity(
  row: Pick<KnowledgeBaseRow, "userId" | "remoteAccountId" | "remoteUserId">,
): KnowledgeTenantIdentity {
  const fallback = row.userId.trim();
  return {
    remoteAccountId: row.remoteAccountId?.trim() || fallback,
    remoteUserId: row.remoteUserId?.trim() || fallback,
  };
}

async function assertUniqueSlug(organizationId: string, slug: string, userId?: string, excludeId?: string) {
  const row = await knowledgeBaseRepo.findByOrgAndSlug(organizationId, normalizeSlug(slug), userId);
  if (row && row.id !== excludeId) {
    throw new Error(`知识库 slug '${normalizeSlug(slug)}' 已存在`);
  }
}

/**
 * 判断远端删除失败是否只是“对象已不存在”。
 * 本地删除要保持幂等：远端已被人工清理时，仍应清掉本地知识库和绑定。
 */
export function isRemoteKnowledgeBaseMissingError(err: unknown): boolean {
  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return (
    message.includes("not found") ||
    message.includes("not exist") ||
    message.includes("nonexistent") ||
    message.includes("dataset not found") ||
    message.includes("http 404") ||
    message.includes("lacks permission") ||
    message.includes("don't own")
  );
}

export async function countKnowledgeBaseBindings(knowledgeBaseId: string): Promise<number> {
  return knowledgeBaseRepo.countBindings(knowledgeBaseId);
}

/**
 * 组装知识库详情 DTO。
 *
 * 收**已授权的知识库行**而不是 `(organizationId, knowledgeBaseId)`：归属判定属于门面（见
 * `../facades/knowledge-access`），领域服务拿到行即拿到全部上下文，不再自行比较组织——迁移前这里
 * 有一处 `row.organizationId !== organizationId` 的判定，它与门面上的判定重复且更容易被绕过。
 */
export async function getKnowledgeBaseDetail(row: KnowledgeBaseRow) {
  const knowledgeBaseId = row.id;
  const resourceRows = await knowledgeResourceRepo.listByKnowledgeBase(knowledgeBaseId, 20);
  const bindingsCount = await countKnowledgeBaseBindings(knowledgeBaseId);
  const resourcesCount = await knowledgeResourceRepo.countByKnowledgeBase(knowledgeBaseId);
  return sanitizeKnowledgeBase(row, {
    bindingsCount,
    resourcesCount,
    recentResources: resourceRows.map((resource) => ({
      id: resource.id,
      sourceName: resource.sourceName,
      sourceType: resource.sourceType,
      status: resource.status as KnowledgeResourceStatus,
      lastError: resource.lastError ?? null,
      createdAt: Math.floor(resource.createdAt.getTime() / 1000),
      updatedAt: Math.floor(resource.updatedAt.getTime() / 1000),
    })),
  });
}

export async function createKnowledgeBaseRecord(
  organizationId: string,
  input: {
    name: string;
    slug?: string;
    description?: string | null;
    embeddingModel?: string | null;
    parseMethod?: "builtin" | "pipeline" | null;
    pipelineId?: string | null;
    chunkMethod?: string | null;
    apiKey?: string;
  },
  userId?: string,
) {
  const nameError = validateName(input.name);
  if (nameError) {
    return { success: false as const, error: { code: "VALIDATION_ERROR", message: nameError } };
  }
  const resolvedSlug = input.slug?.trim() ? input.slug : generateKnowledgeBaseSlug(input.name);
  const slugError = validateSlug(resolvedSlug);
  if (slugError) {
    return { success: false as const, error: { code: "VALIDATION_ERROR", message: slugError } };
  }

  try {
    // 按隔离 slug 唯一性
    await assertUniqueSlug(organizationId, resolvedSlug, userId);
  } catch (error) {
    return { success: false as const, error: { code: "VALIDATION_ERROR", message: (error as Error).message } };
  }

  const provider = getKnowledgeProvider();
  const effectiveUserId = userId ?? organizationId;
  const tenantIdentity = resolveKnowledgeTenantIdentity({
    userId: effectiveUserId,
    remoteAccountId: effectiveUserId,
    remoteUserId: effectiveUserId,
  });
  const effectiveChunkMethod = input.parseMethod === "builtin" ? input.chunkMethod?.trim() || null : null;
  const effectiveParseType = input.parseMethod === "pipeline" ? 2 : input.parseMethod === "builtin" ? 1 : null;
  const effectivePipelineId =
    input.parseMethod === "pipeline" && input.pipelineId?.trim() ? input.pipelineId.trim() : null;
  const remote = await provider.createKnowledgeBase({
    organizationId,
    userId: effectiveUserId,
    slug: normalizeSlug(resolvedSlug),
    name: input.name.trim(),
    description: input.description?.trim() || undefined,
    embeddingModel: input.embeddingModel,
    parseType: effectiveParseType,
    pipelineId: effectivePipelineId,
    chunkMethod: effectiveChunkMethod,
    apiKey: input.apiKey,
  });

  const now = new Date();
  const remoteId = remote.remoteId;
  if (!remoteId) {
    throw new Error("RagFlow createKnowledgeBase did not return a remoteId");
  }
  const row = await knowledgeBaseRepo.create({
    userId: effectiveUserId,
    organizationId,
    name: input.name.trim(),
    slug: normalizeSlug(resolvedSlug),
    description: input.description?.trim() || null,
    provider: "ragflow",
    remoteId,
    remoteAccountId: tenantIdentity.remoteAccountId,
    remoteUserId: tenantIdentity.remoteUserId,
    metadata: mergeKnowledgeBaseMetadata(null, {
      embeddingModel: input.embeddingModel ?? null,
      parseMethod: input.parseMethod ?? null,
      chunkMethod: input.chunkMethod ?? null,
    }),
    status: remote.status,
    lastError: remote.lastError ?? null,
    createdAt: now,
    updatedAt: now,
  });

  return { success: true as const, data: sanitizeKnowledgeBase(row) };
}

// ===== Embedding 模型管理 service =====
// 统一使用全局 RagFlow key，不区分租户。

/** 列出可用厂商 */
// 统一使用 global keySource，通过 ragflow-key shim 解析。
export async function listEmbeddingFactories(_keySource: string, userId: string, orgId: string) {
  const apiKey = await resolveRagflowApiKey("global", userId, orgId);
  return getKnowledgeProvider().listFactories?.(apiKey) ?? [];
}

/**
 * 列出已配置的模型供应商树：provider → instance → models（含每个模型 active/inactive）。
 *
 * RAGFlow 没有「一次拿 provider+instance+model」的接口，需三步：
 * 1. GET /api/v1/providers（不带 available）拿租户已配置的 provider 名单
 * 2. 对每个 provider：GET /providers/<p>/instances 拿实例列表
 * 3. 对每个 instance：GET /providers/<p>/instances/<i>/models 拿模型+状态
 *
 * 必须用 listInstanceModels（不过滤 inactive、带 status）而非 /api/v1/models
 * （后者会把 inactive 模型整个隐藏，无法用于管理 active/inactive）。
 */
export async function listConfiguredProviderTree(
  _keySource: string,
  userId: string,
  orgId: string,
): Promise<ConfiguredProviderNode[]> {
  try {
    const apiKey = await resolveRagflowApiKey("global", userId, orgId);
    const provider = getKnowledgeProvider();

    // 步骤 1：拿租户已配置的 provider 名单（去重，防 RAGFlow 返回重复项）
    const rawNames = (await provider.listConfiguredProviders?.(apiKey)) ?? [];
    const providerNames = Array.from(new Set(rawNames.filter((n) => typeof n === "string" && n.length > 0)));
    if (providerNames.length === 0) return [];

    // 步骤 2+3：逐个 provider 拉实例，再拉每个实例的 embedding 模型
    // （listInstanceModels 已只返回 embedding 类型；实例无 embedding 模型则跳过，
    //   provider 无可用实例则跳过——本页只展示与向量模型相关的供应商/实例）
    const nodes: ConfiguredProviderNode[] = [];
    for (const pName of providerNames) {
      try {
        const instances = (await provider.listProviderInstances?.({ provider: pName, apiKey })) ?? [];
        if (instances.length === 0) continue;
        const instanceNodes: ConfiguredInstanceNode[] = [];
        for (const inst of instances) {
          const models =
            (await provider.listInstanceModels?.({ provider: pName, instanceName: inst.instanceName, apiKey })) ?? [];
          if (models.length === 0) continue; // 该实例无 embedding 模型，跳过
          instanceNodes.push({
            provider: pName,
            instanceName: inst.instanceName,
            status: inst.status,
            models,
          });
        }
        if (instanceNodes.length === 0) continue; // 该 provider 无含 embedding 的实例，跳过
        nodes.push({ provider: pName, instances: instanceNodes });
      } catch (err) {
        console.error(`[embedding] list provider tree failed for ${pName}:`, err);
      }
    }
    return nodes;
  } catch (err) {
    console.error("[embedding] listConfiguredProviderTree failed:", err);
    return [];
  }
}

/** 切换实例下单个模型的 active/inactive 状态（屏蔽/取消屏蔽模型） */
export async function setEmbeddingModelStatus(
  _keySource: string,
  userId: string,
  orgId: string,
  input: { provider: string; instanceName: string; modelName: string; status: "active" | "inactive" },
) {
  const apiKey = await resolveRagflowApiKey("global", userId, orgId);
  await getKnowledgeProvider().setModelStatus?.({
    provider: input.provider,
    instanceName: input.instanceName,
    modelName: input.modelName,
    status: input.status,
    apiKey,
  });
}

/** 列出某实例下的模型（含 active/inactive 状态），供管理页展开实例时按需懒加载 */
export async function listInstanceEmbeddingModels(
  _keySource: string,
  userId: string,
  orgId: string,
  input: { provider: string; instanceName: string },
) {
  const apiKey = await resolveRagflowApiKey("global", userId, orgId);
  return (
    getKnowledgeProvider().listInstanceModels?.({
      provider: input.provider,
      instanceName: input.instanceName,
      apiKey,
    }) ?? []
  );
}

/** 验证厂商 API Key */
export async function verifyEmbeddingProvider(
  _keySource: string,
  userId: string,
  orgId: string,
  input: { provider: string; providerApiKey: string; baseUrl?: string | null },
) {
  const apiKey = await resolveRagflowApiKey("global", userId, orgId);
  return (
    getKnowledgeProvider().verifyProviderConnection?.({
      provider: input.provider,
      providerApiKey: input.providerApiKey,
      baseUrl: input.baseUrl,
      apiKey,
    }) ?? { success: false, message: "provider 不支持 verifyProviderConnection" }
  );
}

/** 动态列出厂商模型库（只看 embedding 类型） */
export async function listProviderEmbeddingModels(
  _keySource: string,
  userId: string,
  orgId: string,
  input: { provider: string; providerApiKey: string; baseUrl?: string | null },
) {
  const apiKey = await resolveRagflowApiKey("global", userId, orgId);
  return (
    getKnowledgeProvider().listProviderModels?.({
      provider: input.provider,
      providerApiKey: input.providerApiKey,
      baseUrl: input.baseUrl,
      modelType: "embedding",
      apiKey,
    }) ?? []
  );
}

/**
 * 添加一个模型供应商：创建厂商实例（含 api_key）。
 *
 * 注意：RAGFlow v0.26 以「供应商实例（绑定的 API Key）」为模型所有权单位，
 * 添加实例后该厂商目录下的所有 embedding 模型自动可用——无需也无法单独勾选模型
 * （tenant_model 行不控制可用性，缺行时上游回退厂商目录）。
 * 因此本函数不再逐个添加模型，只创建实例即可。
 * 幂等：实例已存在时 RAGFlow 返回冲突信息，我们捕获后视为成功。
 */
export async function addEmbeddingProvider(
  _keySource: string,
  userId: string,
  orgId: string,
  input: {
    provider: string;
    instanceName: string;
    providerApiKey: string;
    baseUrl?: string | null;
  },
): Promise<{ instanceName: string }> {
  const apiKey = await resolveRagflowApiKey("global", userId, orgId);
  const provider = getKnowledgeProvider();
  try {
    await provider.addProviderInstance?.({
      provider: input.provider,
      instanceName: input.instanceName,
      providerApiKey: input.providerApiKey,
      baseUrl: input.baseUrl,
      apiKey,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    // 已存在/冲突视为成功
    if (!/exist|conflict|already/i.test(msg)) throw err;
    console.warn("[embedding-provider] instance may already exist:", msg);
  }
  return { instanceName: input.instanceName };
}

/**
 * 删除一个 provider 实例（含其下所有模型配置）。
 *
 * 删除粒度是「实例」（用户配置的一组 API Key）——DELETE /providers/<p>/instances，
 * body { instances: [name] }。删的是 tenant_model_instance 行 + 关联 tenant_model 行，
 * 不删 provider 本身。正在使用该实例 embedding 模型的知识库检索会失败，
 * 调用方应在 UI 层给出明确确认提示。
 */
export async function deleteEmbeddingInstance(
  _keySource: string,
  userId: string,
  orgId: string,
  input: { provider: string; instanceName: string },
) {
  const apiKey = await resolveRagflowApiKey("global", userId, orgId);
  await getKnowledgeProvider().deleteProviderInstance?.({
    provider: input.provider,
    instanceName: input.instanceName,
    apiKey,
  });
}

/**
 * 聚合创建知识库表单所需的全部可选项：
 * - 嵌入模型：动态拉取自 RagFlow（失败兜底空数组）
 * - 分块方法：RagFlow v0.26 chunk_method 静态枚举
 * - pipeline：动态拉取自 RagFlow（best-effort）
 */
export async function listKnowledgeFormOptions(apiKey?: string): Promise<KnowledgeFormOptions> {
  const provider = getKnowledgeProvider();
  const [embeddingModels, pipelines] = await Promise.all([
    provider.listEmbeddingModels(apiKey).catch((err) => {
      console.error("[knowledge] listEmbeddingModels failed", err);
      return [];
    }),
    provider.listPipelines(apiKey).catch((err) => {
      console.error("[knowledge] listPipelines failed", err);
      return [];
    }),
  ]);
  return {
    embeddingModels,
    chunkMethods: KNOWLEDGE_CHUNK_METHODS,
    pipelines,
  };
}

/**
 * 更新知识库的展示字段。
 *
 * 同样收**已授权的知识库行**：归属判定在门面，这里只做名称/slug 校验、slug 唯一性与落库。
 */
export async function updateKnowledgeBase(
  row: KnowledgeBaseRow,
  input: { name?: string; slug?: string; description?: string | null },
) {
  const knowledgeBaseId = row.id;
  if (input.name !== undefined) {
    const nameError = validateName(input.name);
    if (nameError) {
      return { success: false as const, error: { code: "VALIDATION_ERROR", message: nameError } };
    }
  }
  if (input.slug !== undefined) {
    const slugError = validateSlug(input.slug);
    if (slugError) {
      return { success: false as const, error: { code: "VALIDATION_ERROR", message: slugError } };
    }
    try {
      await assertUniqueSlug(row.organizationId, input.slug, row.userId, knowledgeBaseId);
    } catch (error) {
      return { success: false as const, error: { code: "VALIDATION_ERROR", message: (error as Error).message } };
    }
  }

  const updates: Record<string, unknown> = {
    updatedAt: new Date(),
  };
  if (input.name !== undefined) {
    updates.name = input.name.trim();
  }
  if (input.slug !== undefined) {
    updates.slug = normalizeSlug(input.slug);
  }
  if (input.description !== undefined) {
    updates.description = input.description?.trim() || null;
  }
  await knowledgeBaseRepo.update(knowledgeBaseId, updates);
  const updated = await knowledgeBaseRepo.getById(knowledgeBaseId);
  return { success: true as const, data: sanitizeKnowledgeBase(updated!) };
}

/**
 * 删除知识库：先删远端数据集（幂等：远端已不存在时继续），再清理绑定与本地记录。
 *
 * 收**已授权的知识库行**与**已绑定调用者身份的凭据**：归属判定在门面，凭据由门面按调用者构造。
 * 凭据保持惰性——没有远端数据集的历史记录在迁移前不解析凭据，提前解析会让「未配置 RAGFlow」把一个
 * 本可成功的本地删除变成失败（行为等价，逐条保持）。
 */
export async function deleteKnowledgeBase(kb: KnowledgeBaseRow, credential: KnowledgeBaseCredential) {
  const knowledgeBaseId = kb.id;
  if (kb.remoteId) {
    const tenantIdentity = resolveKnowledgeTenantIdentity(kb);
    const apiKey = await credential();
    try {
      await getKnowledgeProvider().deleteKnowledgeBase({
        knowledgeBaseRemoteId: kb.remoteId,
        remoteAccountId: tenantIdentity.remoteAccountId,
        remoteUserId: tenantIdentity.remoteUserId,
        apiKey,
      });
    } catch (err) {
      console.error(err);
      if (!isRemoteKnowledgeBaseMissingError(err)) {
        throw err;
      }
      console.warn("Remote knowledge base is already missing; continuing local deletion", {
        knowledgeBaseId,
        remoteId: kb.remoteId,
        organizationId: kb.organizationId,
      });
    }
  }
  await agentKnowledgeBindingRepo.deleteByKnowledgeBaseId(knowledgeBaseId);
  await knowledgeBaseRepo.delete(knowledgeBaseId);
  return { success: true as const, data: { ok: true } };
}

export async function touchKnowledgeBaseUpdatedAt(
  knowledgeBaseId: string,
  patch?: {
    status?: KnowledgeBaseStatus;
    lastError?: string | null;
    remoteId?: string | null;
  },
) {
  await knowledgeBaseRepo.update(knowledgeBaseId, {
    updatedAt: new Date(),
    ...(patch?.status ? { status: patch.status } : {}),
    ...(patch && "lastError" in patch ? { lastError: patch.lastError ?? null } : {}),
    ...(patch && "remoteId" in patch ? { remoteId: patch.remoteId ?? null } : {}),
  });
}

export async function listKnowledgeBaseResources(knowledgeBaseId: string, limit?: number) {
  return knowledgeResourceRepo.listByKnowledgeBase(knowledgeBaseId, limit);
}

/**
 * 按资源行重算知识库状态。
 *
 * 三类计数之外的资源状态（当前只有 `empty`：解析结束但零分块）**不参与**判定：它既不宣告知识库
 * 就绪——否则知识库会跟着误导用户「可检索」，也不把知识库标成 `error`——单份损坏文件不该让整个
 * 知识库报错。只由 `empty` 资源构成的知识库因此落在默认值 `empty`（无可用内容）。
 */
export async function upsertKnowledgeBaseStatusFromResources(knowledgeBaseId: string) {
  const summary = await knowledgeResourceRepo.getStatusSummary(knowledgeBaseId);

  let status: KnowledgeBaseStatus = "empty";
  if (summary.errorCount > 0) {
    status = "error";
  } else if (summary.activeCount > 0) {
    status = "indexing";
  } else if (summary.readyCount > 0) {
    status = "ready";
  }

  await touchKnowledgeBaseUpdatedAt(knowledgeBaseId, { status });
}
