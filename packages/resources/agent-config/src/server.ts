/** AgentConfig、模板与 Site App 的服务端公开入口。 */

// 浏览器能力走 `./web`。本入口导出的是服务端能力与**它们的注入契约**（端口 / 依赖类型）：路由一律是
// `createXxxRoutes(deps)` 工厂，守卫与宿主侧适配（`user_config` 偏好、站点代理认证）由宿主注入，
// 包侧不 import 宿主实现（CE 阶段 2 任务 1.3，§6.4）。

export { agentConfigResource } from "./server/access/agent-config-resource";
export type { AgentConfigModuleConfig } from "./server/config";
export { getAgentConfigConfig } from "./server/config";
export {
  type AgentConfigModuleDeps,
  type AgentConfigServerModule,
  createAgentConfigServerModule,
} from "./server/module";
export {
  bindMachineLookupPort,
  getMachineLookupPort,
  type MachineLookupPort,
  resetMachineLookupPort,
} from "./server/ports/machine-lookup";
export {
  bindModelLookupPort,
  getModelLookupPort,
  type ModelLookupPort,
  resetModelLookupPort,
} from "./server/ports/model-lookup";
export type {
  UserAgentPreferencesPatch,
  UserAgentPreferencesPort,
  UserAgentPreferencesSnapshot,
  UserAgentPreferencesSubject,
} from "./server/ports/user-agent-preferences";
export * from "./server/repositories/agent-config";
export * from "./server/repositories/agent-site-app";
export {
  createAgentSitesCompatRoutes,
  createAgentSitesProxyRoutes,
  invalidateAppCache,
} from "./server/routes/agent-sites-proxy";
export { createApiAgentsRoutes } from "./server/routes/api/agents";
export type {
  AgentSitesProxyRouteDependencies,
  ApiAgentConfigRouteDependencies,
  AuthenticateSiteRequest,
  SiteRequestIdentity,
  WebAgentConfigRouteDependencies,
  WebConfigAgentsRouteDependencies,
} from "./server/routes/dependencies";
export { createWebAgentGenerationRoutes } from "./server/routes/web/agent-generation";
export { createWebAgentSitesRoutes } from "./server/routes/web/agent-sites";
export { createWebConfigAgentsRoutes } from "./server/routes/web/config/agents";
export { createWebSidebarConfigRoutes } from "./server/routes/web/sidebar-config";
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
export * from "./server/schemas/sidebar-config.schema";
export * from "./server/services/agent-generation";
export * from "./server/services/agent-sites";
export * from "./server/services/agent-system-prompt";
export * from "./server/services/agent-templates";
export { syncBuiltinSkillsToSystemAdmin } from "./server/services/builtin-skills";
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
export { getSidebarConfig, parseHiddenSidebarTabs } from "./server/services/sidebar-config";
