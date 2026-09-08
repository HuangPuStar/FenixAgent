import type { ResourceModule } from "@fenix-ce/platform-sdk";

export const agentConfigResourceModule: ResourceModule = {
  id: "agent-configs",
  schema: "agent_configs(id, name, engine, ownership_scope_kind, ownership_scope_id)",
  migrations: ["0001_create_agent_configs"],
  apiContribution: ["/app/agent-configs"],
  webContribution: ["/agent-configs"],
  capabilities: ["agent-config:read", "agent-config:write", "agent-config:use"],
};
