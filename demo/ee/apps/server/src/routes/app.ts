import { type AgentConfigRunFacade, createAgentConfigAppRoutes } from "@fenix-ce/agent-config";
import type { EnterpriseAgentConfigFacade } from "@fenix-ee/agent-config";

/** EE 在 CE /app route 上静态追加发布动作。 */
export function createEnterpriseAppRoutes(deps: {
  agentConfigs: EnterpriseAgentConfigFacade;
  agentRuns: AgentConfigRunFacade;
}): readonly string[] {
  return [...createAgentConfigAppRoutes(deps), "POST /app/agent-configs/:id/publish"];
}
