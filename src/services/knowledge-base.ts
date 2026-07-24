import { randomBytes } from "node:crypto";
import { config } from "../config";
import type { KnowledgeBaseRow } from "../repositories/knowledge-base";
import { agentKnowledgeBindingRepo, knowledgeBaseRepo, knowledgeResourceRepo } from "../repositories/knowledge-base";
import { getKnowledgeProvider } from "./knowledge-provider/registry";
import type {
  ConfiguredInstanceNode,
  ConfiguredProviderNode,
  KnowledgeBaseStatus,
  KnowledgeResourceStatus,
} from "./knowledge-provider/types";

/** 内置分块方法列表 */
export const KNOWLEDGE_CHUNK_METHODS: Array<{ value: string; label: string }> = [
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

export interface KnowledgeTenantIdentity {
  remoteAccountId: string;
  remoteUserId: string;
}

function _generateKnowledgeBaseId(): string {
  return `kb_${randomBytes(8).toString("hex")}`;
}

function normalizeSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

/**
 * 将任意名称裁剪为可读的 slug base。
 * 仅保留 ASCII 字母和数字，中文等非 ASCII 字符会被清空并走系统前缀兜底。
 */
function buildSlugBase(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * 基于知识库名称生成 kebab-case slug。
 * - 英文/数字名称保留可读前缀
 * - 中文等无法转为 ASCII 的名称回退到 `kb-<suffix>`
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
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(normalized)) {
    return "slug 必须为 kebab-case";
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

function sanitizeKnowledgeBase(
  row: KnowledgeBaseRow,
  extras?: {
    bindingsCount?: number;
    resourcesCount?: number;
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
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description ?? null,
    provider: row.provider,
    remoteId: row.remoteId ?? null,
    remoteAccountId: row.remoteAccountId ?? null,
    remoteUserId: row.remoteUserId ?? null,
    status: row.status as KnowledgeBaseStatus,
    lastError: row.lastError ?? null,
    embeddingModel: row.embeddingModel ?? null,
    parseMethod: row.parseMethod ?? null,
    chunkMethod: row.chunkMethod ?? null,
    bindingsCount: extras?.bindingsCount ?? 0,
    resourcesCount: extras?.resourcesCount ?? 0,
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

async function assertUniqueSlug(organizationId: string, slug: string, excludeId?: string) {
  const row = await knowledgeBaseRepo.findByUserAndSlug(organizationId, normalizeSlug(slug));
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
    message.includes("http 404")
  );
}

export async function countKnowledgeBaseBindings(knowledgeBaseId: string): Promise<number> {
  return knowledgeBaseRepo.countBindings(knowledgeBaseId);
}

export async function listKnowledgeBasesByTeamId(organizationId: string) {
  const rows = await knowledgeBaseRepo.listByOrganizationId(organizationId);
  const items = await Promise.all(
    rows.map(async (row) =>
      sanitizeKnowledgeBase(row, {
        bindingsCount: await countKnowledgeBaseBindings(row.id),
        resourcesCount: await knowledgeResourceRepo.countByKnowledgeBase(row.id),
      }),
    ),
  );
  return items;
}

export async function getKnowledgeBaseDetail(organizationId: string, knowledgeBaseId: string) {
  const row = await knowledgeBaseRepo.getByOrgAndId(organizationId, knowledgeBaseId);
  if (!row) {
    return null;
  }
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
    await assertUniqueSlug(organizationId, resolvedSlug);
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
  const remote = await provider.createKnowledgeBase({
    organizationId,
    userId: effectiveUserId,
    slug: normalizeSlug(resolvedSlug),
    name: input.name.trim(),
    description: input.description?.trim() || undefined,
  });

  const now = new Date();
  // RagFlow createKnowledgeBase always returns dataset_id; null means API error
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
    status: remote.status,
    lastError: remote.lastError ?? null,
    embeddingModel: input.embeddingModel ?? null,
    parseMethod: input.parseMethod ?? null,
    chunkMethod: input.parseMethod === "builtin" ? input.chunkMethod?.trim() || null : null,
    createdAt: now,
    updatedAt: now,
  });

  return { success: true as const, data: sanitizeKnowledgeBase(row) };
}

export async function updateKnowledgeBase(
  organizationId: string,
  knowledgeBaseId: string,
  input: { name?: string; slug?: string; description?: string | null },
) {
  const row = await knowledgeBaseRepo.getByOrgAndId(organizationId, knowledgeBaseId);
  if (!row) {
    return { success: false as const, error: { code: "NOT_FOUND", message: "知识库不存在" } };
  }
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
      await assertUniqueSlug(organizationId, input.slug, knowledgeBaseId);
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

export async function deleteKnowledgeBase(organizationId: string, knowledgeBaseId: string) {
  const row = await knowledgeBaseRepo.getByOrgAndId(organizationId, knowledgeBaseId);
  if (!row) {
    return { success: false as const, error: { code: "NOT_FOUND", message: "知识库不存在" } };
  }
  if (row.remoteId) {
    const tenantIdentity = resolveKnowledgeTenantIdentity(row);
    try {
      await getKnowledgeProvider().deleteKnowledgeBase({
        knowledgeBaseRemoteId: row.remoteId,
        remoteAccountId: tenantIdentity.remoteAccountId,
        remoteUserId: tenantIdentity.remoteUserId,
      });
    } catch (err) {
      console.error(err);
      if (!isRemoteKnowledgeBaseMissingError(err)) {
        throw err;
      }
      console.warn("Remote knowledge base is already missing; continuing local deletion", {
        knowledgeBaseId,
        remoteId: row.remoteId,
        organizationId,
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

// ===== Embedding 模型管理 service =====
// 全部使用全局 RAGFlow API Key（分层功能已移除）。

/** 列出可用厂商 */
export async function listEmbeddingFactories() {
  const provider = getKnowledgeProvider();
  if (!config.ragflowApiKey) return [];
  return provider.listFactories?.(config.ragflowApiKey) ?? [];
}

/**
 * 列出已配置的模型供应商树：provider → instance → models。
 */
export async function listConfiguredProviderTree(): Promise<ConfiguredProviderNode[]> {
  try {
    if (!config.ragflowApiKey) return [];
    const provider = getKnowledgeProvider();
    const rawNames = (await provider.listConfiguredProviders?.(config.ragflowApiKey)) ?? [];
    const providerNames = Array.from(new Set(rawNames.filter((n) => typeof n === "string" && n.length > 0)));
    if (providerNames.length === 0) return [];

    const nodes: ConfiguredProviderNode[] = [];
    for (const pName of providerNames) {
      try {
        const instances =
          (await provider.listProviderInstances?.({ provider: pName, apiKey: config.ragflowApiKey })) ?? [];
        if (instances.length === 0) continue;
        const instanceNodes: ConfiguredInstanceNode[] = [];
        for (const inst of instances) {
          const models =
            (await provider.listInstanceModels?.({
              provider: pName,
              instanceName: inst.instanceName,
              apiKey: config.ragflowApiKey,
            })) ?? [];
          if (models.length === 0) continue;
          instanceNodes.push({
            provider: pName,
            instanceName: inst.instanceName,
            status: inst.status,
            models,
          });
        }
        if (instanceNodes.length === 0) continue;
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

/** 切换实例下单个模型的 active/inactive 状态 */
export async function setEmbeddingModelStatus(input: {
  provider: string;
  instanceName: string;
  modelName: string;
  status: "active" | "inactive";
}) {
  if (!config.ragflowApiKey) throw new Error("RAGFLOW_API_KEY is not configured");
  await getKnowledgeProvider().setModelStatus?.({ ...input, apiKey: config.ragflowApiKey });
}

/** 列出某实例下的模型 */
export async function listInstanceEmbeddingModels(input: { provider: string; instanceName: string }) {
  if (!config.ragflowApiKey) return [];
  return getKnowledgeProvider().listInstanceModels?.({ ...input, apiKey: config.ragflowApiKey }) ?? [];
}

/** 验证厂商 API Key */
export async function verifyEmbeddingProvider(input: {
  provider: string;
  providerApiKey: string;
  baseUrl?: string | null;
}) {
  if (!config.ragflowApiKey) throw new Error("RAGFLOW_API_KEY is not configured");
  return (
    getKnowledgeProvider().verifyProviderConnection?.({ ...input, apiKey: config.ragflowApiKey }) ?? {
      success: false,
      message: "provider 不支持 verifyProviderConnection",
    }
  );
}

/** 动态列出厂商模型库 */
export async function listProviderEmbeddingModels(input: {
  provider: string;
  providerApiKey: string;
  baseUrl?: string | null;
}) {
  if (!config.ragflowApiKey) return [];
  return (
    getKnowledgeProvider().listProviderModels?.({ ...input, modelType: "embedding", apiKey: config.ragflowApiKey }) ??
    []
  );
}

/** 添加模型供应商 */
export async function addEmbeddingProvider(input: {
  provider: string;
  instanceName: string;
  providerApiKey: string;
  baseUrl?: string | null;
}): Promise<{ instanceName: string }> {
  if (!config.ragflowApiKey) throw new Error("RAGFLOW_API_KEY is not configured");
  const provider = getKnowledgeProvider();
  try {
    await provider.addProviderInstance?.({ ...input, apiKey: config.ragflowApiKey });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (!/exist|conflict|already/i.test(msg)) throw err;
    console.warn("[embedding-provider] instance may already exist:", msg);
  }
  return { instanceName: input.instanceName };
}

/** 删除一个 provider 实例 */
export async function deleteEmbeddingInstance(input: { provider: string; instanceName: string }) {
  if (!config.ragflowApiKey) throw new Error("RAGFLOW_API_KEY is not configured");
  await getKnowledgeProvider().deleteProviderInstance?.({ ...input, apiKey: config.ragflowApiKey });
}
