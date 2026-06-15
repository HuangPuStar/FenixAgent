import { randomUUID } from "node:crypto";
import { agentKnowledgeBindingRepo, knowledgeBaseRepo } from "../repositories/knowledge-base";

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
  config?: AgentKnowledgePolicy | null;
}

export class InvalidKnowledgeBindingError extends Error {
  code = "INVALID_KNOWLEDGE_BINDINGS";
}

const DEFAULT_SEARCH_FIRST = true;
const DEFAULT_MAX_RESULTS = 5;

function generateBindingId(): string {
  return randomUUID();
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
export function resolveAgentKnowledgePolicy(policy?: AgentKnowledgePolicy | null): ResolvedAgentKnowledgePolicy {
  return {
    searchFirst: policy?.searchFirst ?? DEFAULT_SEARCH_FIRST,
    maxResults: policy?.maxResults ?? DEFAULT_MAX_RESULTS,
    defaultNamespaces: Array.isArray(policy?.defaultNamespaces)
      ? policy!.defaultNamespaces.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0,
        )
      : [],
  };
}

/**
 * Counts how many agent bindings exist for each knowledge base id.
 */
export async function countBindingsByKnowledgeBaseIds(knowledgeBaseIds: string[]): Promise<Record<string, number>> {
  const ids = normalizeKnowledgeBaseIds(knowledgeBaseIds);
  if (ids.length === 0) {
    return {};
  }

  return agentKnowledgeBindingRepo.countByKnowledgeBaseIds(ids);
}

/**
 * Lists enabled knowledge base bindings for an agent config in priority order.
 */
let _listAgentKnowledgeBindingsById: ((agentConfigId: string) => Promise<AgentKnowledgeBindingRecord[]>) | null = null;

/** 测试用：注入自定义实现。传 null 恢复默认。 */
export function setListAgentKnowledgeBindingsById(
  fn: ((agentConfigId: string) => Promise<AgentKnowledgeBindingRecord[]>) | null,
) {
  _listAgentKnowledgeBindingsById = fn;
}

export async function listAgentKnowledgeBindingsById(agentConfigId: string): Promise<AgentKnowledgeBindingRecord[]> {
  if (_listAgentKnowledgeBindingsById) return _listAgentKnowledgeBindingsById(agentConfigId);
  const rows = await agentKnowledgeBindingRepo.listEnabledByAgentConfigId(agentConfigId);
  return rows.map((row) => ({
    knowledgeBaseId: row.knowledgeBaseId,
    priority: row.priority,
    enabled: row.enabled,
    config: (row.config as AgentKnowledgePolicy | null | undefined) ?? null,
  }));
}

/**
 * Rebuilds the legacy agent knowledge payload from binding rows.
 */
export async function getAgentKnowledgeConfigById(agentConfigId: string): Promise<AgentKnowledgeConfig | null> {
  const bindings = await listAgentKnowledgeBindingsById(agentConfigId);
  if (bindings.length === 0) {
    return null;
  }

  const firstConfig = bindings.find((binding) => binding.config && typeof binding.config === "object")?.config ?? null;
  return {
    knowledgeBaseIds: bindings.map((binding) => binding.knowledgeBaseId),
    policy: firstConfig,
  };
}

/**
 * Replaces all agent knowledge bindings for an agent config with the provided ordered knowledge base ids.
 */
export async function syncAgentKnowledgeBindingsById(
  organizationId: string,
  agentConfigId: string,
  knowledge: AgentKnowledgeConfig | null | undefined,
): Promise<void> {
  const knowledgeBaseIds = normalizeKnowledgeBaseIds(knowledge?.knowledgeBaseIds);
  const normalizedPolicy = knowledge?.policy ? resolveAgentKnowledgePolicy(knowledge.policy) : null;
  await agentKnowledgeBindingRepo.deleteByAgentConfigId(agentConfigId);

  if (knowledgeBaseIds.length === 0) {
    return;
  }

  const existingIds = new Set<string>();
  for (const kbId of knowledgeBaseIds) {
    const kb = await knowledgeBaseRepo.getByOrgAndId(organizationId, kbId);
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
      agentConfigId,
      knowledgeBaseId,
      config: normalizedPolicy,
      priority,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    })),
  );
}
