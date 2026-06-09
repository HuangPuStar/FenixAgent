import type { AgentDetail } from "../types/config";
import type { KnowledgeBaseInfo } from "../types/knowledge";

export function isValidAgentNameInput(name: string): boolean {
  return /^[\p{L}0-9]+(?:-[\p{L}0-9]+)*$/u.test(name) && name.length >= 1 && name.length <= 64;
}

export interface AgentKnowledgeFormState {
  knowledgeBaseIds: string[];
  searchFirst: boolean;
  maxResults: string;
}

export function getDefaultKnowledgeFormState(): AgentKnowledgeFormState {
  return {
    knowledgeBaseIds: [],
    searchFirst: true,
    maxResults: "5",
  };
}

export function buildKnowledgeFormState(detail: Pick<AgentDetail, "knowledge">): AgentKnowledgeFormState {
  return {
    knowledgeBaseIds: detail.knowledge?.knowledgeBaseIds ?? [],
    searchFirst: detail.knowledge?.policy?.searchFirst ?? true,
    maxResults: String(detail.knowledge?.policy?.maxResults ?? 5),
  };
}

export function filterKnowledgeBaseIds(selectedIds: string[], knowledgeOptions: Pick<KnowledgeBaseInfo, "id">[]) {
  const validIds = new Set(knowledgeOptions.map((item) => item.id));
  return selectedIds.filter((id) => validIds.has(id));
}

export function buildAgentPayload(input: {
  modelId: string;
  prompt: string;
  description: string;
  knowledge: AgentKnowledgeFormState;
}) {
  return {
    modelId: input.modelId || undefined,
    prompt: input.prompt || undefined,
    description: input.description || undefined,
    knowledge: {
      knowledgeBaseIds: input.knowledge.knowledgeBaseIds,
      policy: {
        searchFirst: input.knowledge.searchFirst,
        maxResults: Number(input.knowledge.maxResults || 5),
      },
    },
  };
}
