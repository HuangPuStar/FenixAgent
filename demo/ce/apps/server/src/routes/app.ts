import { type AgentConfigFacade, type AgentConfigRunFacade, createAgentConfigAppRoutes } from "@fenix-ce/agent-config";

/** app 只汇总模块 route contribution；资源 route 实现仍在资源模块内。 */
export function createAppRoutes(deps: {
  agentConfigs: AgentConfigFacade;
  agentRuns: AgentConfigRunFacade;
}): readonly string[] {
  return createAgentConfigAppRoutes(deps);
}
