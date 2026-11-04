import { runInTransaction } from "@fenix/platform-sdk/server";
import { lockAgentConfigForUpdate } from "../repositories/agent-config-resource";
import type { AgentAssociations } from "./agent-associations";
import type { AgentBindingRequest } from "./agent-bindings";

/** An authorized write plus fully validated associations; external effects are excluded. */
export interface AgentConfigSaveCommand<T extends { id: string }> {
  readonly resourceId?: string;
  readonly organizationId: string;
  readonly write: () => Promise<T>;
  readonly bindings: AgentBindingRequest;
  readonly enableMemory?: boolean;
  readonly associations: AgentAssociations;
}

/** Atomically replace only supplied values, serializing updates to the same Agent. */
export async function saveAgentConfig<T extends { id: string }>(command: AgentConfigSaveCommand<T>): Promise<T> {
  return runInTransaction(async () => {
    if (command.resourceId) await lockAgentConfigForUpdate(command.resourceId);
    const row = await command.write();
    const { associations, bindings } = command;
    if (bindings.skillIds !== undefined) await associations.syncSkills(row.id, bindings.skillIds);
    if (bindings.mcpIds !== undefined) await associations.syncMcps(row.id, bindings.mcpIds);
    if (bindings.siteAppIds !== undefined) await associations.syncSiteApps(row.id, bindings.siteAppIds);
    if (bindings.knowledge !== undefined)
      await associations.syncKnowledge(row.id, bindings.knowledge, command.organizationId);
    if (command.enableMemory !== undefined) await associations.setMemoryEnabled(row.id, command.enableMemory);
    return row;
  });
}
