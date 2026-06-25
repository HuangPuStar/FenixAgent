import type { ComponentType } from "react";
import { AgentSitesCard } from "../../components/agent-panel/AgentSitesCard";
import { registerTagRenderer } from "./registry";

registerTagRenderer("agent-sites", {
  component: AgentSitesCard as unknown as ComponentType<Record<string, unknown>>,
  allowedAttrs: ["agent-site-id"],
});
