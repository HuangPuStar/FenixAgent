import { agentConfigResourceModule } from "@fenix-ce/agent-config";
import { agentConfigWebContribution } from "@fenix-ce/agent-config/web";
import type { ModuleManifest } from "@fenix-ce/platform-sdk";

/** AgentConfig 的完整资源交付物，由生成器发现，是否启用仍由 assembly 决定。 */
export const moduleManifest = {
  id: "agent-config",
  kind: "resource",
  dependsOn: [],
  resourceModule: agentConfigResourceModule,
  web: { id: "agent-config", contribution: agentConfigWebContribution },
} satisfies ModuleManifest;
