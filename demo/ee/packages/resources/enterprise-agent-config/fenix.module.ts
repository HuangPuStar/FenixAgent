import type { ModuleManifest } from "@fenix-ce/platform-sdk";
import { agentConfigPublicationModule } from "@fenix-ee/agent-config";
import { enterpriseAgentConfigWebContribution } from "@fenix-ee/agent-config/web";

/** 发布扩展必须建立在基础 AgentConfig 资源之上。 */
export const moduleManifest = {
  id: "agent-config-publication",
  kind: "resource",
  dependsOn: ["agent-config"],
  resourceModule: agentConfigPublicationModule,
  web: { id: "enterprise-agent-config", contribution: enterpriseAgentConfigWebContribution },
} satisfies ModuleManifest;
