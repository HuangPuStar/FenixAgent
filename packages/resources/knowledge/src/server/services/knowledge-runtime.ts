/**
 * 知识运行时：检索与知识图谱。
 *
 * 控制台端点（检索测试、图谱生成/读取/删除/进度）收**已解析的知识库行 + 调用者身份的凭据**：归属判定与
 * 凭据解析属于门面（见 `../facades/knowledge-access`）。迁移前这里有一份 `resolveKbWithApiKey` 同时做
 * 「读行 + 解析 key」，控制台组织口径现在只由门面决定。
 *
 * Agent 侧入口（`readKnowledgeResourceForAgent` / `searchKnowledgeByConfigId` / `getKnowledgeGraphForAgent`）
 * 的授权来自 agent 知识库绑定，并按注入的组织上下文过滤，不经过控制台门面。
 */

import type { KnowledgeBaseRow } from "../repositories/knowledge-base";
import { agentKnowledgeBindingRepo, knowledgeResourceRepo } from "../repositories/knowledge-base";
import type { KnowledgeBaseCredential } from "./knowledge-credential";
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
    .filter((row) => !!row.kbRemoteId && (orgId === undefined || row.kbOrganizationId === orgId))
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

  for (const [_model, modelKbs] of byModel) {
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
 * 检索测试：按单个知识库检索，返回保留完整字段的详细结果（供知识库详情页检索测试 UI 使用）。
 * 与 searchKnowledgeByConfigId 的区别：
 * - 不依赖 agent 绑定，直接按知识库检索（用户在知识库详情页测试）
 * - 返回 KnowledgeRetrievalDetailedResult（含三种相似度分、高亮、文档聚合）
 *
 * 访问范围：收已解析的知识库行与凭据，本函数不做组织判断——「这个 ID 能不能被当前 actor 访问」由门面
 * 在解析阶段回答（见 `../facades/knowledge-access`）。
 */
export async function searchKnowledgeForTest(input: {
  kb: KnowledgeBaseRow;
  credential: KnowledgeBaseCredential;
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
  const kb = input.kb;
  // 凭据先解析、再校验远端定位：与迁移前 resolveKbWithApiKey 的顺序一致（凭据失败不会被误报成未同步）。
  const apiKey = await input.credential();
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
 *
 * 收已解析的知识库行与凭据；凭据先解析、再校验远端定位，与迁移前顺序一致。
 */
export async function generateKnowledgeGraphForKb(input: {
  kb: KnowledgeBaseRow;
  credential: KnowledgeBaseCredential;
}): Promise<void> {
  const kb = input.kb;
  const apiKey = await input.credential();
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
  kb: KnowledgeBaseRow;
  credential: KnowledgeBaseCredential;
}): Promise<{ graph: { nodes: KnowledgeGraphNode[]; edges: KnowledgeGraphEdge[] }; mind_map?: unknown } | null> {
  const kb = input.kb;
  const apiKey = await input.credential();
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
  kb: KnowledgeBaseRow;
  credential: KnowledgeBaseCredential;
}): Promise<void> {
  const kb = input.kb;
  const apiKey = await input.credential();
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
  kb: KnowledgeBaseRow;
  credential: KnowledgeBaseCredential;
}): Promise<{ progress: number; progressMsg?: string; taskId?: string }> {
  const kb = input.kb;
  const apiKey = await input.credential();
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
