import { AgentSitesCard } from "../../components/agent-panel/AgentSitesCard";
import { registerTagRenderer } from "./registry";

registerTagRenderer("agent-sites", {
  component: AgentSitesCard as unknown as React.ComponentType<Record<string, unknown>>,
});
