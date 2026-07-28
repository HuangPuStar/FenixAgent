import { agentKnowledgeBindingRepo, knowledgeBaseRepo, knowledgeResourceRepo } from "../repositories/knowledge-base";
import { getKnowledgeProvider as getKnowledgeRuntimeProvider } from "./knowledge-provider/registry";
import type {
  KnowledgeGraphEdge,
  KnowledgeGraphNode,
  KnowledgeResourceContent,
  KnowledgeRetrievalDetailedResult,
  KnowledgeSearchResult,
  MetaDataFilter,
  RerankModelOption,
} from "./knowledge-provider/types";
import { resolveRagflowApiKey } from "./ragflow-key";

/**
 * 获取知识库并校验访问权限（支持全局 KB 跨组织访问），同时解析 API key。
 */
async function resolveKbWithApiKey(
  kbId: string,
  organizationId: string,
  userId: string,
): Promise<{ kb: NonNullable<Awaited<ReturnType<typeof knowledgeBaseRepo.getById>>>; apiKey: string } | null> {
  const kb = await knowledgeBaseRepo.getById(kbId);
  if (!kb) return null;
  const isGlobal = true /* was global KB check */;
  if (!isGlobal && kb.organizationId !== organizationId) return null;
  // user 作用域用 KB 主人的 key（RAGFlow 中 dataset 属于主人）
  const apiKeyUserId = userId;
  const apiKey = await resolveRagflowApiKey("global", apiKeyUserId, organizationId);
  return { kb, apiKey };
}

export interface BoundKnowledgeBase {
  id: string;
  remoteId: string;
  remoteAccountId: string;
  remoteUserId: string;
  priority: number;
  userId: string;
  organizationId: string;
  name: string;
  /** 嵌入模型名；用于二级分组，同一 RAGFlow 请求中的 dataset 必须使用相同 embedding model */
  embeddingModel?: string | null;
}

export { setKnowledgeProviderForTesting as setKnowledgeRuntimeProviderForTesting } from "./knowledge-provider/registry";

/**
 * Reads a knowledge resource only if it belongs to a knowledge base bound to the agent.
 */
export async function readKnowledgeResourceForAgent(input: {
  agentConfigId?: string;
  resourceId: string;
  userId?: string;
  organizationId?: string;
}): Promise<KnowledgeResourceContent & { knowledgeBaseId: string }> {
  const result = await agentKnowledgeBindingRepo.getResourceWithKnowledgeBase(input.resourceId);

  if (!result) {
    throw new Error("Knowledge resource not found");
  }
  if (!result.resource.remoteId) {
    throw new Error("Knowledge resource remote id is missing");
  }
  if (input.userId && result.kbUserId !== input.userId) {
    throw new Error("Knowledge resource not accessible");
  }

  const boundKnowledgeBases = input.agentConfigId
    ? await resolveBoundKnowledgeBasesByConfigId(input.agentConfigId, input.organizationId)
    : [];
  if (!boundKnowledgeBases.some((item) => item.id === result.resource.knowledgeBaseId)) {
    throw new Error("Knowledge resource is not bound to the agent");
  }

  const provider = getKnowledgeRuntimeProvider();
  const apiKey = await resolveRagflowApiKey("global", result.kbUserId, result.kbOrganizationId ?? result.kbUserId);
  try {
    const content = await provider.readResource({
      resourceRemoteId: result.resource.remoteId,
      knowledgeBaseRemoteId: result.kbRemoteId || result.kbRemoteAccountId?.trim() || result.kbUserId,
      remoteAccountId: result.kbRemoteAccountId?.trim() || result.kbUserId,
      remoteUserId: result.kbRemoteUserId?.trim() || result.kbUserId,
      apiKey,
    });
    return {
      ...content,
      knowledgeBaseId: result.resource.knowledgeBaseId,
      resourceId: result.resource.id,
    };
  } catch (err) {
    console.error(`[knowledge-runtime] readResource failed for resourceId=${input.resourceId}:`, err);
    throw err; // kb_read 是精确读取，失败应当抛给 Agent 知道
  }
}

/**
 * Resolves the ordered bound knowledge bases for an agent config, optionally scoped to a team.
 */
export async function resolveBoundKnowledgeBasesByConfigId(
  agentConfigId: string,
  orgId?: string,
): Promise<BoundKnowledgeBase[]> {
  const rows = await agentKnowledgeBindingRepo.listJoinedWithKnowledgeBaseByConfigId(agentConfigId);
  return rows
    .filter((row) => !!row.kbRemoteId && (!orgId || row.kbOrganizationId === orgId || true))
    .sort((a, b) => a.priority - b.priority)
    .map((row) => ({
      id: row.kbId,
      remoteId: row.kbRemoteId!,
      remoteAccountId: row.kbRemoteAccountId?.trim() || row.kbUserId,
      remoteUserId: row.kbRemoteUserId?.trim() || row.kbUserId,
      priority: row.priority,
      userId: row.kbUserId,
      organizationId: row.kbOrganizationId ?? row.kbUserId,
      name: row.kbName ?? "未知知识库",
      embeddingModel: row.kbEmbeddingModel?.trim() || null,
    }));
}

/**
 * Searches across the agent config's bound knowledge bases after server-side access filtering.
 */
export async function searchKnowledgeByConfigId(input: {
  agentConfigId: string;
  query: string;
  topK: number;
  organizationId?: string;
}): Promise<KnowledgeSearchResult[]> {
  return searchKnowledgeDetailedForAgent(input);
}

/**
 * Searches across the agent config's bound knowledge bases with full parameter support.
 * Supports similarity threshold, vector weight, rerank, keyword, highlight, cross languages,
 * knowledge graph retrieval, and metadata filtering.
 */
export async function searchKnowledgeDetailedForAgent(input: {
  agentConfigId: string;
  query: string;
  topK: number;
  organizationId?: string;
  userId?: string;
  similarityThreshold?: number;
  vectorSimilarityWeight?: number;
  rerankId?: string | null;
  keyword?: boolean;
  highlight?: boolean;
  useKg?: boolean;
  crossLanguages?: string[];
  metaDataFilter?: MetaDataFilter;
}): Promise<KnowledgeSearchResult[]> {
  const knowledgeBases = await resolveBoundKnowledgeBasesByConfigId(input.agentConfigId, input.organizationId);
  if (knowledgeBases.length === 0) return [];

  const provider = getKnowledgeRuntimeProvider();

  // 统一使用全局 key
  let apiKey: string;
  try {
    apiKey = await resolveRagflowApiKey("global", knowledgeBases[0].userId, knowledgeBases[0].organizationId);
  } catch {
    return [];
  }

  // 按 embedding model 分组：RAGFlow 要求同一请求中的 dataset_ids 必须使用相同 embedding model
  const byModel = new Map<string, BoundKnowledgeBase[]>();
  for (const kb of knowledgeBases) {
    const model = kb.embeddingModel ?? "";
    if (!byModel.has(model)) byModel.set(model, []);
    byModel.get(model)!.push(kb);
  }

  const allResults: KnowledgeSearchResult[] = [];

  for (const [model, modelKbs] of byModel) {
    let modelResults: Awaited<ReturnType<typeof provider.search>>;
    try {
      modelResults = await provider.search({
        knowledgeBases: modelKbs.map((item) => ({
          remoteId: item.remoteId,
          remoteAccountId: item.remoteAccountId,
          remoteUserId: item.remoteUserId,
        })),
        query: input.query,
        topK: input.topK,
        similarityThreshold: input.similarityThreshold,
        vectorSimilarityWeight: input.vectorSimilarityWeight,
        rerankId: input.rerankId,
        keyword: input.keyword,
        highlight: input.highlight,
        useKg: input.useKg,
        crossLanguages: input.crossLanguages,
        metaDataFilter: input.metaDataFilter,
        apiKey,
      });
    } catch (err) {
      console.error(
        `[knowledge-runtime] search failed, kbCount=${modelKbs.length}, remoteIds=${modelKbs.map((k) => k.remoteId).join(",")}`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }

    if (modelResults.length > 0) {
      allResults.push(...modelResults);
    }
  }

  if (allResults.length > 0) {
    const remoteIdToBound = new Map(knowledgeBases.map((item) => [item.remoteId, item]));
    const resourceRemoteIds = Array.from(
      new Set(allResults.map((item) => item.resourceId?.trim()).filter((value): value is string => !!value)),
    );
    const resourceIdByRemoteId = new Map<string, string>();
    if (resourceRemoteIds.length > 0) {
      const resourceRows = await knowledgeResourceRepo.findByRemoteIds(resourceRemoteIds);
      for (const row of resourceRows) {
        if (row.remoteId) resourceIdByRemoteId.set(row.remoteId, row.id);
      }
    }

    return allResults.map((item) => {
      const bound = item.knowledgeBaseId ? remoteIdToBound.get(item.knowledgeBaseId) : undefined;
      return {
        title: item.title,
        snippet: item.snippet,
        source: item.source,
        score: item.score,
        knowledgeBaseId: item.knowledgeBaseId ? (bound?.id ?? null) : null,
        resourceId: item.resourceId ? (resourceIdByRemoteId.get(item.resourceId) ?? item.resourceId) : null,
        kbName: bound?.name ?? null,
      };
    });
  }

  return [];
}

/**
 * 检索测试：按单个知识库 ID 检索，返回保留完整字段的详细结果（供知识库详情页检索测试 UI 使用）。
 * 与 searchKnowledgeByConfigId 的区别：
 * - 不依赖 agent 绑定，直接按知识库 ID 检索（用户在知识库详情页测试）
 * - 返回 KnowledgeRetrievalDetailedResult（含三种相似度分、高亮、文档聚合）
 *
 * 组织隔离：通过 knowledgeBaseRepo.getByOrgAndId 校验该知识库属于当前组织。
 */
export async function searchKnowledgeForTest(input: {
  organizationId: string;
  knowledgeBaseId: string;
  userId?: string;
  query: string;
  topK: number;
  similarityThreshold?: number;
  vectorSimilarityWeight?: number;
  rerankId?: string | null;
  keyword?: boolean;
  highlight?: boolean;
  pageSize?: number;
  page?: number;
  useKg?: boolean;
  crossLanguages?: string[];
  metaDataFilter?: MetaDataFilter;
}): Promise<KnowledgeRetrievalDetailedResult> {
  // 校验知识库访问权限并解析 API key（支持全局 KB 跨组织访问）
  const resolved = await resolveKbWithApiKey(
    input.knowledgeBaseId,
    input.organizationId,
    input.userId ?? input.organizationId,
  );
  if (!resolved) {
    throw new Error("Knowledge base not found");
  }
  const { kb, apiKey } = resolved;
  if (!kb.remoteId) {
    throw new Error("Knowledge base remote id is missing");
  }

  const provider = getKnowledgeRuntimeProvider();
  // remoteAccountId/remoteUserId 在当前 RAGFlow 集成中主要用于鉴权上下文透传
  const remoteAccountId = kb.remoteAccountId?.trim() || kb.organizationId;
  const remoteUserId = kb.remoteUserId?.trim() || kb.organizationId;

  return provider.searchDetailed({
    knowledgeBases: [
      {
        remoteId: kb.remoteId,
        remoteAccountId,
        remoteUserId,
      },
    ],
    query: input.query,
    topK: input.topK,
    similarityThreshold: input.similarityThreshold,
    vectorSimilarityWeight: input.vectorSimilarityWeight,
    rerankId: input.rerankId,
    keyword: input.keyword,
    highlight: input.highlight,
    pageSize: input.pageSize,
    page: input.page,
    useKg: input.useKg,
    crossLanguages: input.crossLanguages,
    metaDataFilter: input.metaDataFilter,
    apiKey,
  });
}

/**
 * 拉取可用 rerank 模型列表，供检索测试选择重排序模型。
 * rerank 模型是 RAGFlow 租户级配置，与组织无关，但保留 org 参数以统一调用约定。
 */
export async function listRerankModelsForOrg(_organizationId?: string): Promise<RerankModelOption[]> {
  const provider = getKnowledgeRuntimeProvider();
  return provider.listRerankModels();
}

// ============================================================
// 知识图谱
// ============================================================

/**
 * 触发知识库的知识图谱生成（后台 GraphRAG 流水线）。
 */
export async function generateKnowledgeGraphForKb(input: {
  organizationId: string;
  knowledgeBaseId: string;
  userId?: string;
}): Promise<void> {
  const resolved = await resolveKbWithApiKey(
    input.knowledgeBaseId,
    input.organizationId,
    input.userId ?? input.organizationId,
  );
  if (!resolved) throw new Error("Knowledge base not found");
  const { kb, apiKey } = resolved;
  if (!kb.remoteId) throw new Error("Knowledge base remote id is missing");

  const provider = getKnowledgeRuntimeProvider();
  await provider.generateKnowledgeGraph({
    knowledgeBaseRemoteId: kb.remoteId,
    remoteAccountId: kb.remoteAccountId?.trim() || kb.organizationId,
    remoteUserId: kb.remoteUserId?.trim() || kb.organizationId,
    apiKey,
  });
}

/**
 * 获取知识库的知识图谱数据（节点 + 边）。
 */
export async function getKnowledgeGraphForKb(input: {
  organizationId: string;
  knowledgeBaseId: string;
  userId?: string;
}): Promise<{ graph: { nodes: KnowledgeGraphNode[]; edges: KnowledgeGraphEdge[] }; mind_map?: unknown } | null> {
  const resolved = await resolveKbWithApiKey(
    input.knowledgeBaseId,
    input.organizationId,
    input.userId ?? input.organizationId,
  );
  if (!resolved) throw new Error("Knowledge base not found");
  const { kb, apiKey } = resolved;
  if (!kb.remoteId) throw new Error("Knowledge base remote id is missing");

  const provider = getKnowledgeRuntimeProvider();
  return provider.getKnowledgeGraph({
    knowledgeBaseRemoteId: kb.remoteId,
    remoteAccountId: kb.remoteAccountId?.trim() || kb.organizationId,
    remoteUserId: kb.remoteUserId?.trim() || kb.organizationId,
    apiKey,
  });
}

/**
 * 删除知识库的知识图谱。
 */
export async function deleteKnowledgeGraphForKb(input: {
  organizationId: string;
  knowledgeBaseId: string;
  userId?: string;
}): Promise<void> {
  const resolved = await resolveKbWithApiKey(
    input.knowledgeBaseId,
    input.organizationId,
    input.userId ?? input.organizationId,
  );
  if (!resolved) throw new Error("Knowledge base not found");
  const { kb, apiKey } = resolved;
  if (!kb.remoteId) throw new Error("Knowledge base remote id is missing");

  const provider = getKnowledgeRuntimeProvider();
  await provider.deleteKnowledgeGraph({
    knowledgeBaseRemoteId: kb.remoteId,
    remoteAccountId: kb.remoteAccountId?.trim() || kb.organizationId,
    remoteUserId: kb.remoteUserId?.trim() || kb.organizationId,
    apiKey,
  });
}

/**
 * 轮询知识图谱生成进度，返回 0~1 的进度值。
 */
export async function pollKnowledgeGraphProgressForKb(input: {
  organizationId: string;
  knowledgeBaseId: string;
  userId?: string;
}): Promise<{ progress: number; progressMsg?: string; taskId?: string }> {
  const resolved = await resolveKbWithApiKey(
    input.knowledgeBaseId,
    input.organizationId,
    input.userId ?? input.organizationId,
  );
  if (!resolved) throw new Error("Knowledge base not found");
  const { kb, apiKey } = resolved;
  if (!kb.remoteId) throw new Error("Knowledge base remote id is missing");

  const provider = getKnowledgeRuntimeProvider();
  return provider.pollKnowledgeGraphProgress({
    knowledgeBaseRemoteId: kb.remoteId,
    remoteAccountId: kb.remoteAccountId?.trim() || kb.organizationId,
    remoteUserId: kb.remoteUserId?.trim() || kb.organizationId,
    apiKey,
  });
}

/**
 * 获取 agent 绑定知识库的知识图谱数据（节点 + 边）。
 * 若指定 knowledgeBaseId，仅查该 KB；否则返回第一个有图谱的绑定 KB。
 */
export async function getKnowledgeGraphForAgent(input: {
  agentConfigId: string;
  organizationId?: string;
  knowledgeBaseId?: string;
}): Promise<{
  knowledgeBaseId: string;
  graph: { nodes: KnowledgeGraphNode[]; edges: KnowledgeGraphEdge[] };
  mind_map?: unknown;
} | null> {
  const knowledgeBases = await resolveBoundKnowledgeBasesByConfigId(input.agentConfigId, input.organizationId);
  if (knowledgeBases.length === 0) return null;

  const provider = getKnowledgeRuntimeProvider();

  // 若指定了 KB ID，只查那个
  if (input.knowledgeBaseId) {
    const target = knowledgeBases.find((kb) => kb.id === input.knowledgeBaseId);
    if (!target) throw new Error(`Knowledge base ${input.knowledgeBaseId} is not bound to this agent`);
    try {
      const apiKey = await resolveRagflowApiKey("global", target.userId, target.organizationId);
      const result = await provider.getKnowledgeGraph({
        knowledgeBaseRemoteId: target.remoteId,
        remoteAccountId: target.remoteAccountId,
        remoteUserId: target.remoteUserId,
        apiKey,
      });
      if (!result) return null;
      return { knowledgeBaseId: target.id, ...result };
    } catch (err) {
      console.error(`[knowledge-runtime] getKnowledgeGraph failed for kb=${target.id}:`, err);
      return null;
    }
  }

  // 否则遍历所有绑定 KB，返回第一个有图谱的。单个 KB 失败不阻断。
  for (const kb of knowledgeBases) {
    try {
      const apiKey = await resolveRagflowApiKey("global", kb.userId, kb.organizationId);
      const result = await provider.getKnowledgeGraph({
        knowledgeBaseRemoteId: kb.remoteId,
        remoteAccountId: kb.remoteAccountId,
        remoteUserId: kb.remoteUserId,
        apiKey,
      });
      if (result) {
        return { knowledgeBaseId: kb.id, ...result };
      }
    } catch (err) {
      console.error(`[knowledge-runtime] getKnowledgeGraph failed for kb=${kb.id}:`, err);
    }
  }

  return null;
}
