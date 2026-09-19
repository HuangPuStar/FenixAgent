import type { AgentKnowledgeConfig } from "@fenix/resource-knowledge/server";
import {
  getAgentKnowledgeConfigById,
  listAgentKnowledgeBindingsById,
  syncAgentKnowledgeBindingsById,
} from "@fenix/resource-knowledge/server";
import { listAgentMcpIds, syncAgentMcps } from "@fenix/resource-mcp/server/config";
import { isAgentMemoryEnabled, setEnabled as setAgentMemoryEnabled } from "@fenix/resource-memory/server";
import { listAgentSkillIds, syncAgentSkills } from "@fenix/resource-skill/server/config";
import { listAgentSiteAppIds, syncAgentSiteApps } from "./config/agent-config-site-app";

/**
 * Agent 关联资源绑定（Skill / MCP / SiteApp / 知识库 / 记忆）的统一门面。
 *
 * 绑定表分散在各自的资源包里（`agent_config_skill` 归 skill、`agent_config_mcp` 归 mcp、
 * 知识库绑定归 knowledge、记忆开关归 memory），但"谁拥有哪张绑定表"这件事只应由本模块知道：
 * 路由与 Facade 通过它读写绑定，不直接 import 资源包，避免每加一种关联就在协议层散落一处跨包导入。
 *
 * 本模块只做读写编排，不做授权判断：绑定集合的合法性（Skill 是否可见、知识库是否属于当前组织）
 * 由调用方在持有 actor 的层次上先完成。
 */
export interface AgentAssociations {
  listSkillIds(agentConfigId: string): Promise<string[]>;
  syncSkills(agentConfigId: string, skillIds: readonly string[]): Promise<void>;
  listMcpIds(agentConfigId: string): Promise<string[]>;
  syncMcps(agentConfigId: string, mcpServerIds: readonly string[]): Promise<void>;
  listSiteAppIds(agentConfigId: string): Promise<string[]>;
  syncSiteApps(agentConfigId: string, siteAppIds: readonly string[]): Promise<void>;
  listKnowledgeBindings(agentConfigId: string): Promise<{ knowledgeBaseId: string }[]>;
  getKnowledge(agentConfigId: string): Promise<AgentKnowledgeConfig | null>;
  syncKnowledge(agentConfigId: string, knowledge: AgentKnowledgeConfig | null | undefined): Promise<void>;
  isMemoryEnabled(agentConfigId: string): Promise<boolean>;
  setMemoryEnabled(agentConfigId: string, enabled: boolean): Promise<void>;
}

export function createAgentAssociations(): AgentAssociations {
  return {
    listSkillIds: (agentConfigId) => listAgentSkillIds(agentConfigId),
    syncSkills: (agentConfigId, skillIds) => syncAgentSkills(agentConfigId, [...skillIds]),
    listMcpIds: (agentConfigId) => listAgentMcpIds(agentConfigId),
    syncMcps: (agentConfigId, mcpServerIds) => syncAgentMcps(agentConfigId, [...mcpServerIds]),
    listSiteAppIds: (agentConfigId) => listAgentSiteAppIds(agentConfigId),
    syncSiteApps: (agentConfigId, siteAppIds) => syncAgentSiteApps(agentConfigId, [...siteAppIds]),
    listKnowledgeBindings: (agentConfigId) => listAgentKnowledgeBindingsById(agentConfigId),
    getKnowledge: (agentConfigId) => getAgentKnowledgeConfigById(agentConfigId),
    syncKnowledge: (agentConfigId, knowledge) => syncAgentKnowledgeBindingsById(agentConfigId, knowledge),
    isMemoryEnabled: (agentConfigId) => isAgentMemoryEnabled(agentConfigId),
    setMemoryEnabled: async (agentConfigId, enabled) => {
      await setAgentMemoryEnabled(agentConfigId, enabled);
    },
  };
}
