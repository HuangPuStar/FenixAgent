import { createLogger } from "@fenix/logger";
import { AppError } from "@fenix/platform-sdk";
import { type InstanceEnvironmentType, listApiAgentInstances } from "../repositories/agent-instance";
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

const logger = createLogger("api-instance");

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
  query: { page: number; pageSize: number; environmentType?: InstanceEnvironmentType },
) {
  const agent = await getAgentConfigLookupPort().findVisibleAgentConfig({ ...owner, agentConfigId });
  if (!agent) throw new AppError("Agent not found", "NOT_FOUND", 404);
  const result = await listApiAgentInstances({
    ...owner,
    agentConfigId,
    environmentType: query.environmentType,
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });
  return {
    items: result.items.map((instance) =>
      toApiInstanceDetail({ agentConfigId, environmentId: instance.environmentId, instance }),
    ),
    total: result.total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/** 授权后提交严格停止；HTTP 仅确认受理，最终状态由原生命周期仲裁器维护。 */
export async function stopApiInstance(owner: InstanceOwner, id: string) {
  const resolved = await getApiOwnedInstance(owner, id);
  const runtime = agentInstanceService.getRuntimeSnapshot(id);
  if (runtime.deleting) throw new AppError("Agent Instance is being deleted", "INSTANCE_DELETING", 409);
  if (runtime.currentOperation === "stop") return null;
  // 仲裁器持有停止操作及关闭时的排空责任，不把任务生命周期绑定到 HTTP 请求。
  const stopping = agentInstanceService.stopInstanceRuntime(resolved.instance, "strict");
  if (agentInstanceService.getRuntimeSnapshot(id).currentOperation === "stop") {
    void stopping.catch((error) => {
      logger.error("Background instance stop failed", error, { instanceId: id, environmentId: resolved.environmentId });
    });
  } else {
    // 合法 stop 会同步占槽；未占槽的即刻拒绝必须留在 HTTP 错误路径。
    try {
      await stopping;
    } catch (error) {
      logger.error("Instance stop was not accepted", error, { instanceId: id, environmentId: resolved.environmentId });
      const unavailable = new AppError("Instance stop is unavailable", "INSTANCE_STOP_UNAVAILABLE", 503);
      unavailable.cause = error;
      throw unavailable;
    }
  }
  return null;
}

/** Explicit restart preserves identity and returns the new generation. */
export async function restartApiInstance(owner: InstanceOwner, id: string) {
  const resolved = await getApiOwnedInstance(owner, id, undefined, true);
  await agentInstanceService.restartInstanceRuntime(resolved.instance);
  return toApiInstanceDetail(resolved);
}
