/** AgentConfig、模板与 Site App 的服务端公开入口。 */

export { default as webSidebarConfigRoutes } from "./routes/web/sidebar-config";
export * from "./schemas/meta-agent.schema";
export { agentConfigResource } from "./server/access/agent-config-resource";
export {
  type AgentConfigModuleDeps,
  type AgentConfigServerModule,
  createAgentConfigServerModule,
} from "./server/module";
export * from "./server/repositories/agent-config";
export * from "./server/repositories/agent-site-app";
export {
  agentSitesCompatApp,
  agentSitesProxyApp,
  invalidateAppCache,
} from "./server/routes/agent-sites-proxy";
export { default as apiAgentsRoutes } from "./server/routes/api/agents";
export { default as webAgentGenerationRoutes } from "./server/routes/web/agent-generation";
export { default as webAgentSitesRoutes } from "./server/routes/web/agent-sites";
export { default as webConfigAgentsRoutes } from "./server/routes/web/config/agents";
export { getAgentConfigModule, installAgentConfigModule, resetAgentConfigModule } from "./server/runtime";
export type {
  AgentGenerationResponse,
  AgentGenerationSkill,
} from "./server/schemas/agent-generation.schema";
export {
  AgentGenerationResponseSchema,
  AgentGenerationResultSchema,
  AgentGenerationSkillSchema,
} from "./server/schemas/agent-generation.schema";
export * from "./server/schemas/agent-site.schema";
export * from "./server/schemas/api-agent.schema";
export * from "./server/services/agent-generation";
export * from "./server/services/agent-sites";
export * from "./server/services/agent-system-prompt";
export * from "./server/services/agent-templates";
export * from "./server/services/config";
export * from "./server/services/config/agent-config";
export * from "./server/services/config/agent-config-site-app";
export type {
  AgentConfigDetailWithAccess,
  AgentConfigRowWithAccess,
  AgentConfigUpsertData,
  AgentExtraConfig,
  AgentKnowledgeConfig,
  AgentKnowledgePolicy,
  AgentNode,
} from "./server/services/config/types";
export * from "./services/meta-agent";
