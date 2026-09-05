import type { AgentConfigFacade } from "../services/agent-config-facade";
import type { AgentConfigRunFacade } from "../services/agent-config-run-facade";

/** `/app` 的最小 route contribution；真实 Elysia route 在此处绑定 DTO 和错误码。 */
export function createAgentConfigAppRoutes(deps: {
  agentConfigs: AgentConfigFacade;
  agentRuns: AgentConfigRunFacade;
}): readonly string[] {
  void deps;
  return ["GET /app/agent-configs", "POST /app/agent-configs", "POST /app/agent-configs/:id/run"];
}
