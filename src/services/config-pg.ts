// config-pg.ts 现在是桶文件，所有实现已迁移到 src/services/config/ 目录。
// 保持此文件以兼容现有 import 路径。
export {
  listProviders, getProvider, upsertProvider, deleteProvider,
  addModel, updateModel, removeModel,
  AGENT_SETTABLE_FIELDS, listAgentConfigs, getAgentConfig, getAgentConfigById,
  createAgentConfig, updateAgentConfig, deleteAgentConfig,
  listMcpServers, getMcpServer, createMcpServer, updateMcpServer, deleteMcpServer, setMcpServerEnabled,
  listSkills, listWorkspaceSkills, getSkill, upsertSkill, deleteSkill, enableSkill, disableSkill,
  getUserConfig, setUserConfig,
  getAgentFullConfig,
} from "./config/index";
export type { UserConfigData, AgentFullConfig } from "./config/index";
