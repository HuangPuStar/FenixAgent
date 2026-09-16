import type { ResourceAccess } from "@fenix/access-control/server";

export type AgentKnowledgePolicy = {
  searchFirst?: boolean;
  maxResults?: number;
  defaultNamespaces?: string[];
};

export type AgentKnowledgeConfig = {
  knowledgeBaseIds: string[];
  policy?: AgentKnowledgePolicy | null;
};

export type AgentExtraConfig = Record<string, unknown>;

export type AgentNode =
  | { kind?: never; machineId?: never; sandboxPoolId?: never }
  | { kind: "machine"; machineId: string }
  | { kind: "sandbox"; sandboxPoolId: string };

export interface AgentConfigUpsertData {
  modelId?: string | null;
  prompt?: string | null;
  description?: string | null;
  extra?: AgentExtraConfig | null;
  knowledge?: AgentKnowledgeConfig | null;
  agentNode?: AgentNode | null;
  skillIds?: string[];
  mcpIds?: string[];
}

export interface AgentConfigRowWithAccess {
  id: string;
  userId: string;
  organizationId: string;
  name: string;
  prompt: string | null;
  modelId: string | null;
  model: string | null;
  description: string | null;
  machineId: string | null;
  agentNode?: AgentNode | null;
  extra?: AgentExtraConfig | null;
  createdAt: Date;
  updatedAt: Date;
  enableMemory?: boolean;
  resourceAccess: ResourceAccess;
}

export interface AgentConfigDetailWithAccess extends AgentConfigRowWithAccess {
  skillIds?: string[];
  mcpIds?: string[];
}
