import { agentKnowledgeBindingRepo, knowledgeResourceRepo } from "../repositories/knowledge-base";
import {
  getKnowledgeProvider as getKnowledgeRuntimeProvider,
  setKnowledgeProviderForTesting as setKnowledgeRuntimeProviderForTesting,
} from "./knowledge-provider/registry";
import type { KnowledgeResourceContent, KnowledgeSearchResult } from "./knowledge-provider/types";

export interface BoundKnowledgeBase {
  id: string;
  remoteId: string;
  remoteAccountId: string;
  remoteUserId: string;
  priority: number;
}

export { setKnowledgeProviderForTesting as setKnowledgeRuntimeProviderForTesting } from "./knowledge-provider/registry";

/**
 * Reads a knowledge resource only if it belongs to a knowledge base bound to the agent.
 */
export async function readKnowledgeResourceForAgent(input: {
  agentConfigId?: string;
  resourceId: string;
  userId?: string;
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
    ? await resolveBoundKnowledgeBasesByConfigId(input.agentConfigId, input.userId)
    : [];
  if (!boundKnowledgeBases.some((item) => item.id === result.resource.knowledgeBaseId)) {
    throw new Error("Knowledge resource is not bound to the agent");
  }

  const provider = getKnowledgeRuntimeProvider();
  const content = await provider.readResource({
    resourceRemoteId: result.resource.remoteId,
    remoteAccountId: result.kbRemoteAccountId?.trim() || result.kbUserId,
    remoteUserId: result.kbRemoteUserId?.trim() || result.kbUserId,
  });
  return {
    ...content,
    knowledgeBaseId: result.resource.knowledgeBaseId,
    resourceId: result.resource.id,
  };
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
    .filter((row) => !!row.kbRemoteId && (!orgId || row.kbUserId === organizationId))
    .sort((a, b) => a.priority - b.priority)
    .map((row) => ({
      id: row.kbId,
      remoteId: row.kbRemoteId!,
      remoteAccountId: row.kbRemoteAccountId?.trim() || row.kbUserId,
      remoteUserId: row.kbRemoteUserId?.trim() || row.kbUserId,
      priority: row.priority,
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
  const knowledgeBases = await resolveBoundKnowledgeBasesByConfigId(input.agentConfigId, input.organizationId);
  if (knowledgeBases.length === 0) return [];

  const provider = getKnowledgeRuntimeProvider();
  const results = await provider.search({
    knowledgeBases: knowledgeBases.map((item) => ({
      remoteId: item.remoteId,
      remoteAccountId: item.remoteAccountId,
      remoteUserId: item.remoteUserId,
    })),
    query: input.query,
    topK: input.topK,
  });

  const knowledgeBaseIdByRemoteId = new Map(knowledgeBases.map((item) => [item.remoteId, item.id]));
  const resourceRemoteIds = Array.from(
    new Set(results.map((item) => item.resourceId?.trim()).filter((value): value is string => !!value)),
  );
  const resourceIdByRemoteId = new Map<string, string>();
  if (resourceRemoteIds.length > 0) {
    const resourceRows = await knowledgeResourceRepo.findByRemoteIds(resourceRemoteIds);
    for (const row of resourceRows) {
      if (row.remoteId) resourceIdByRemoteId.set(row.remoteId, row.id);
    }
  }

  return results.map((item) => ({
    title: item.title,
    snippet: item.snippet,
    source: item.source,
    score: item.score,
    knowledgeBaseId: item.knowledgeBaseId
      ? (knowledgeBaseIdByRemoteId.get(item.knowledgeBaseId) ?? item.knowledgeBaseId)
      : null,
    resourceId: item.resourceId ? (resourceIdByRemoteId.get(item.resourceId) ?? item.resourceId) : null,
  }));
}
