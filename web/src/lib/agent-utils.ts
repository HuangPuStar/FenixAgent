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
  /** 预选模型 UUID 列表（presetTouched=false 时忽略，保持存量 null 语义） */
  modelIds: string[];
  /** 是否显式配置过预选列表：false（存量 null / 创建未动）→ 不传 modelIds 保持引擎自报 */
  presetTouched: boolean;
  expertIds: string[];
  prompt: string;
  description: string;
  knowledge: AgentKnowledgeFormState;
  engineType?: string;
}) {
  return {
    modelId: input.modelId || undefined,
    // 预选模型列表：presetTouched=false（存量 modelIds=null 或创建未配置）时不传字段，
    // 避免前端保存把存量 null（引擎自报）意外改写为 []（单模型）——兼容不变量
    ...(input.presetTouched ? { modelIds: input.modelIds } : {}),
    expertIds: input.expertIds,
    prompt: input.prompt || undefined,
    description: input.description || undefined,
    engineType: input.engineType ?? "opencode",
    knowledge: {
      knowledgeBaseIds: input.knowledge.knowledgeBaseIds,
      policy: {
        searchFirst: input.knowledge.searchFirst,
        maxResults: Number(input.knowledge.maxResults || 5),
      },
    },
  };
}
