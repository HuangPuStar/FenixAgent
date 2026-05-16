import { randomBytes } from "node:crypto";
import {
  agentKnowledgeBindingRepo,
  knowledgeBaseRepo,
} from "../repositories/knowledge-base";

export interface AgentKnowledgePolicy {
  searchFirst?: boolean;
  maxResults?: number;
  defaultNamespaces?: string[];
}

export interface AgentKnowledgeConfig {
  knowledgeBaseIds: string[];
  policy?: AgentKnowledgePolicy | null;
}

export interface ResolvedAgentKnowledgePolicy {
  searchFirst: boolean;
  maxResults: number;
  defaultNamespaces: string[];
}

export interface AgentKnowledgeBindingRecord {
  knowledgeBaseId: string;
  priority: number;
  enabled: boolean;
}

export class InvalidKnowledgeBindingError extends Error {
  code = "INVALID_KNOWLEDGE_BINDINGS";
}

const DEFAULT_SEARCH_FIRST = true;
const DEFAULT_MAX_RESULTS = 5;

function generateBindingId(): string {
  return `akb_${randomBytes(8).toString("hex")}`;
}

function normalizeKnowledgeBaseIds(knowledgeBaseIds: string[] | undefined): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const value of knowledgeBaseIds ?? []) {
    if (typeof value !== "string") continue;
    const id = value.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * Resolves a complete runtime policy object from optional agent knowledge config.
 */
export function resolveAgentKnowledgePolicy(
  policy?: AgentKnowledgePolicy | null,
): ResolvedAgentKnowledgePolicy {
  return {
    searchFirst: policy?.searchFirst ?? DEFAULT_SEARCH_FIRST,
    maxResults: policy?.maxResults ?? DEFAULT_MAX_RESULTS,
    defaultNamespaces: Array.isArray(policy?.defaultNamespaces)
      ? policy!.defaultNamespaces.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [],
  };
}

/**
 * Lists enabled knowledge base bindings for an agent in priority order.
 */
export async function listAgentKnowledgeBindings(agentName: string): Promise<AgentKnowledgeBindingRecord[]> {
  const rows = await agentKnowledgeBindingRepo.listEnabledByAgentName(agentName);
  return rows.map((row) => ({
    knowledgeBaseId: row.knowledgeBaseId,
    priority: row.priority,
    enabled: row.enabled,
  }));
}

/**
 * Counts how many agent bindings exist for each knowledge base id.
 */
export async function countBindingsByKnowledgeBaseIds(
  knowledgeBaseIds: string[],
): Promise<Record<string, number>> {
  const ids = normalizeKnowledgeBaseIds(knowledgeBaseIds);
  if (ids.length === 0) {
    return {};
  }

  return agentKnowledgeBindingRepo.countByKnowledgeBaseIds(ids);
}

/**
 * Replaces all agent knowledge bindings with the provided ordered knowledge base ids.
 */
export async function syncAgentKnowledgeBindings(
  userId: string,
  agentName: string,
  knowledge: AgentKnowledgeConfig | null | undefined,
): Promise<void> {
  const knowledgeBaseIds = normalizeKnowledgeBaseIds(knowledge?.knowledgeBaseIds);
  await agentKnowledgeBindingRepo.deleteByAgentName(agentName);

  if (knowledgeBaseIds.length === 0) {
    return;
  }

  // Verify all referenced knowledge bases exist and belong to the user
  const existingIds = new Set<string>();
  for (const kbId of knowledgeBaseIds) {
    const kb = await knowledgeBaseRepo.getByUserAndId(userId, kbId);
    if (kb) {
      existingIds.add(kb.id);
    }
  }
  const missingIds = knowledgeBaseIds.filter((id) => !existingIds.has(id));
  if (missingIds.length > 0) {
    throw new InvalidKnowledgeBindingError(`知识库不存在或无权限访问: ${missingIds.join(", ")}`);
  }

  const now = new Date();
  await agentKnowledgeBindingRepo.createMany(
    knowledgeBaseIds.map((knowledgeBaseId, priority) => ({
      id: generateBindingId(),
      agentName,
      knowledgeBaseId,
      priority,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    })),
  );
}
