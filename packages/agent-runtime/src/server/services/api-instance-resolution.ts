import { createHash } from "node:crypto";
import { AppError } from "@fenix/platform-sdk";
import { type AgentInstanceRecord, agentInstanceRepo } from "../repositories/agent-instance";
import { withApiEnvironmentLock } from "../repositories/api-environment";
import { environmentRepo } from "../repositories/environment";
import { getAgentConfigLookupPort } from "./agent-config-lookup-port";
import { agentInstanceService } from "./agent-instance-service";
import { createWebEnvironment } from "./environment-web";

/** Only credential-derived organization and user identity are accepted. */
export interface InstanceOwner {
  readonly organizationId: string;
  readonly userId: string;
}
/** Fully authorized selection, before runtime readiness is ensured by the caller. */
export interface ResolvedApiAgentInstance {
  agentConfigId: string;
  environmentId: string;
  instance: AgentInstanceRecord;
}
const defaultDeps = {
  findVisibleAgentConfig: (input: {
    agentConfigId: string;
    organizationId: string;
    userId: string;
    action?: "read" | "use";
  }) => getAgentConfigLookupPort().findVisibleAgentConfig(input),
  getOwnedInstance: agentInstanceRepo.findOwnedById.bind(agentInstanceRepo),
  getEnvironmentById: environmentRepo.getById.bind(environmentRepo),
  listEnvironmentsByOrganizationId: environmentRepo.listByOrganizationId.bind(environmentRepo),
  createWebEnvironment,
  withEnvironmentLock: withApiEnvironmentLock,
  resolveInstance: agentInstanceService.resolveInstanceForOperation.bind(agentInstanceService),
  ensureInstanceRuntime: agentInstanceService.ensureInstanceRuntime.bind(agentInstanceService),
};
const deps = { ...defaultDeps };
/** Existing runtime dependency seam, restored after each test. */
export function setApiInstanceResolutionDeps(overrides: Partial<typeof deps> | null): void {
  Object.assign(deps, overrides ?? defaultDeps);
}
const unavailable = () => new AppError("Instance not found", "NOT_FOUND", 404);

/** Reauthorize an existing instance and its Environment without creating or starting anything. */
export async function getApiOwnedInstance(
  owner: InstanceOwner,
  instanceId: string,
  agentConfigId?: string,
): Promise<ResolvedApiAgentInstance> {
  const instance = await deps.getOwnedInstance(instanceId, owner.userId);
  if (!instance || instance.ownerUserId !== owner.userId || instance.creationSource === "workflow") throw unavailable();
  const environment = await deps.getEnvironmentById(instance.environmentId);
  if (
    !environment ||
    environment.organizationId !== owner.organizationId ||
    environment.userId !== owner.userId ||
    !environment.agentConfigId ||
    (agentConfigId !== undefined && environment.agentConfigId !== agentConfigId)
  )
    throw unavailable();
  const agent = await deps.findVisibleAgentConfig({
    ...owner,
    agentConfigId: environment.agentConfigId,
    action: "use",
  });
  if (!agent) throw unavailable();
  return { agentConfigId: agent.id, environmentId: environment.id, instance };
}

/** Shared HTTP connect/Chat policy; runtime starts only after the environment transaction commits. */
export async function resolveApiAgentInstance(
  owner: InstanceOwner,
  agentConfigId: string,
  options: { instanceId?: string; signal?: AbortSignal } = {},
): Promise<ResolvedApiAgentInstance> {
  options.signal?.throwIfAborted();
  if (options.instanceId) return getApiOwnedInstance(owner, options.instanceId, agentConfigId);
  const agent = await deps.findVisibleAgentConfig({ ...owner, agentConfigId, action: "use" });
  if (!agent) throw new AppError("Agent not found", "NOT_FOUND", 404);
  const environment = await deps.withEnvironmentLock(owner, agentConfigId, async () => {
    options.signal?.throwIfAborted();
    const candidates = (await deps.listEnvironmentsByOrganizationId(owner.organizationId))
      .filter(
        (env) =>
          env.organizationId === owner.organizationId && env.userId === owner.userId && env.agentConfigId === agent.id,
      )
      .sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0) || a.id.localeCompare(b.id));
    if (candidates[0]) return candidates[0];
    const suffix = createHash("sha256")
      .update(JSON.stringify([owner.userId, agent.id]))
      .digest("hex")
      .slice(0, 20);
    return deps.createWebEnvironment({
      name: `api-${suffix}`,
      description: agent.description ?? undefined,
      agentConfigId: agent.id,
      autoStart: true,
      userId: owner.userId,
      organizationId: owner.organizationId,
    });
  });
  options.signal?.throwIfAborted();
  const instance = await deps.resolveInstance({
    environmentId: environment.id,
    ownerUserId: owner.userId,
    automaticSelection: "api",
  });
  return { agentConfigId: agent.id, environmentId: environment.id, instance };
}

/** Ensure the selected shared runtime without transferring lifetime ownership to the request. */
export function ensureApiInstanceRuntime(instance: AgentInstanceRecord, signal?: AbortSignal): Promise<void> {
  return deps.ensureInstanceRuntime(instance, signal);
}
