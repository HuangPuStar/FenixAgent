import { AppError } from "@fenix/platform-sdk";
import { listApiAgentInstances } from "../repositories/agent-instance";
import { getAgentConfigLookupPort } from "./agent-config-lookup-port";
import { agentInstanceService } from "./agent-instance-service";
import {
  ensureApiInstanceRuntime,
  getApiOwnedInstance,
  type InstanceOwner,
  type ResolvedApiAgentInstance,
  resolveApiAgentInstance,
} from "./api-instance-resolution";

export type { InstanceOwner } from "./api-instance-resolution";
export { setApiInstanceResolutionDeps as setApiInstanceDeps } from "./api-instance-resolution";

/** Published v1 connect options use the persistent instance ID. */
export interface AgentInstanceConnectOptions {
  instanceId?: string;
  signal?: AbortSignal;
}
/** ACP stays an independent protocol with its existing authenticated relay URL. */
export interface AgentInstanceConnectResult {
  agentConfigId: string;
  environmentId: string;
  instanceId: string;
  status: "running";
  runtimeGeneration: number;
  relay: { wsUrl: string };
}

/** Resolve and prepare an owned api/user instance; request completion does not stop it. */
export async function connectAgentInstance(
  owner: InstanceOwner,
  agentConfigId: string,
  options: AgentInstanceConnectOptions = {},
): Promise<AgentInstanceConnectResult> {
  const resolved = await resolveApiAgentInstance(owner, agentConfigId, options);
  await ensureApiInstanceRuntime(resolved.instance, options.signal);
  const instanceId = resolved.instance.id;
  return {
    agentConfigId: resolved.agentConfigId,
    environmentId: resolved.environmentId,
    instanceId,
    status: "running",
    runtimeGeneration: agentInstanceService.getRuntimeSnapshot(instanceId).runtimeGeneration,
    relay: { wsUrl: `/acp/relay/${resolved.environmentId}?instanceId=${instanceId}` },
  };
}

/** Credential-safe instance details; internal failure text never crosses this boundary. */
export function toApiInstanceDetail(resolved: ResolvedApiAgentInstance) {
  const row = resolved.instance;
  const runtime = agentInstanceService.getRuntimeSnapshot(row.id);
  return {
    instanceId: row.id,
    agentConfigId: resolved.agentConfigId,
    environmentId: resolved.environmentId,
    name: row.name,
    creationSource: row.creationSource,
    isDefault: row.isDefault,
    status: runtime.state,
    runtimeGeneration: runtime.runtimeGeneration,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Read-only listing does not prepare environments or start runtimes. */
export async function listApiInstances(
  owner: InstanceOwner,
  agentConfigId: string,
  query: { page: number; pageSize: number },
) {
  const agent = await getAgentConfigLookupPort().findVisibleAgentConfig({ ...owner, agentConfigId });
  if (!agent) throw new AppError("Agent not found", "NOT_FOUND", 404);
  const result = await listApiAgentInstances({
    ...owner,
    agentConfigId,
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });
  return {
    items: result.items.map((instance) =>
      toApiInstanceDetail({ agentConfigId, environmentId: instance.environmentId, instance }),
    ),
    total: result.total,
    ...query,
  };
}

/** Strict stop affects the selected instance only. */
export async function stopApiInstance(owner: InstanceOwner, id: string) {
  const resolved = await getApiOwnedInstance(owner, id);
  await agentInstanceService.stopInstanceRuntime(resolved.instance, "strict");
  return null;
}

/** Explicit restart preserves identity and returns the new generation. */
export async function restartApiInstance(owner: InstanceOwner, id: string) {
  const resolved = await getApiOwnedInstance(owner, id);
  await agentInstanceService.restartInstanceRuntime(resolved.instance);
  return toApiInstanceDetail(resolved);
}
