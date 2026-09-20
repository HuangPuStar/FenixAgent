import type { ResourceAccess } from "@fenix/platform-sdk";
import type { ScopedAgentConfigRow } from "../../repositories/agent-config-resource";

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

/**
 * 带上当前主体有效动作的资源行。
 *
 * 直接继承资源行类型而不是手抄一份字段：手抄的副本会在 schema 增列时静默落后，而 LaunchSpec 构建
 * 这类系统路径正是靠这些字段读配置的。`scope` 由 `ScopedAgentConfigRow` 提供，授权视图因此是
 * `scope + access`（旧栈的 `resourceAccess` 只保留在对外 `/api/*` 协议里，见
 * `@fenix/platform-sdk` 的 `toResourceAccessView`）。
 */
export interface AgentConfigRowWithAccess extends ScopedAgentConfigRow {
  readonly access: ResourceAccess;
}

export interface AgentConfigDetailWithAccess extends AgentConfigRowWithAccess {
  skillIds?: string[];
  mcpIds?: string[];
}
