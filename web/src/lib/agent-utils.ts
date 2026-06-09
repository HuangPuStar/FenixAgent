import type { AgentDetail, AgentInfo } from "../types/config";
import type { KnowledgeBaseInfo } from "../types/knowledge";

export const DEFAULT_AGENT_MODE = "primary";

export function isValidAgentNameInput(name: string): boolean {
  return /^[\p{L}0-9]+(?:-[\p{L}0-9]+)*$/u.test(name) && name.length >= 1 && name.length <= 64;
}

export function isValidStepsInput(steps: string): boolean {
  const n = parseInt(steps, 10);
  return !Number.isNaN(n) && n >= 1 && n <= 200;
}

export function filterSubagents(agents: AgentInfo[]): AgentInfo[] {
  return agents.filter((a) => a.mode === "subagent");
}

export function getDisplayAgents(agents: AgentInfo[], pageTab: "all" | "primary" | "subagent"): AgentInfo[] {
  if (pageTab === "subagent") return agents.filter((a) => a.mode === "subagent");
  if (pageTab === "primary") return agents.filter((a) => a.mode !== "subagent");
  return agents;
}

export function getSubagentColumnKeys(): string[] {
  return ["name", "builtIn", "model", "description"];
}

export function getFullAgentColumnKeys(): string[] {
  return ["name", "builtIn", "model", "mode", "default"];
}

export function buildSubagentFormData(params: {
  name: string;
  model: string;
  description: string;
  prompt: string;
  steps: string;
  disable: boolean;
}): Record<string, unknown> {
  return {
    mode: "subagent",
    model: params.model || undefined,
    steps: parseInt(params.steps, 10),
    prompt: params.prompt || undefined,
    description: params.description || undefined,
    disable: params.disable,
  };
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
  model: string;
  mode: string;
  steps: string;
  prompt: string;
  description: string;
  variant: string;
  temperature: string;
  topP: string;
  color: string;
  hidden: boolean;
  disable: boolean;
  permission: Record<string, unknown> | null;
  knowledge: AgentKnowledgeFormState;
  engineType?: string;
}) {
  return {
    model: input.model || undefined,
    mode: input.mode,
    steps: parseInt(input.steps, 10),
    prompt: input.prompt || undefined,
    description: input.description || undefined,
    variant: input.variant || undefined,
    temperature: input.temperature !== "" ? parseFloat(input.temperature) : undefined,
    top_p: input.topP !== "" ? parseFloat(input.topP) : undefined,
    color: input.color || undefined,
    hidden: input.hidden,
    disable: input.disable,
    permission: input.permission,
    engineType: input.engineType || "opencode",
    knowledge: {
      knowledgeBaseIds: input.knowledge.knowledgeBaseIds,
      policy: {
        searchFirst: input.knowledge.searchFirst,
        maxResults: Number(input.knowledge.maxResults || 5),
      },
    },
  };
}
