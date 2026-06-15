import { AppError } from "../errors";
import type { AuthContext } from "../plugins/auth";
import { type EnvironmentRecord, environmentRepo } from "../repositories/environment";
import { getAgentConfigById } from "./config";
import { createWebEnvironment } from "./environment-web";
import {
  getRunningInstancesByEnvironment,
  groupActiveInstancesByEnvironment,
  spawnInstanceFromEnvironment,
} from "./instance";

type InstanceDeps = {
  createWebEnvironment: typeof createWebEnvironment;
  getAgentConfigById: typeof getAgentConfigById;
  getRunningInstancesByEnvironment: typeof getRunningInstancesByEnvironment;
  groupActiveInstancesByEnvironment: typeof groupActiveInstancesByEnvironment;
  listEnvironmentsByOrganizationId: typeof environmentRepo.listByOrganizationId;
  spawnInstanceFromEnvironment: typeof spawnInstanceFromEnvironment;
};

const defaultDeps: InstanceDeps = {
  createWebEnvironment,
  getAgentConfigById,
  getRunningInstancesByEnvironment,
  groupActiveInstancesByEnvironment,
  listEnvironmentsByOrganizationId: async (organizationId: string) =>
    environmentRepo.listByOrganizationId(organizationId),
  spawnInstanceFromEnvironment,
};

let deps: InstanceDeps = defaultDeps;

/**
 * 测试覆盖 instance service 依赖，避免路由测试触达真实 DB 和 runtime。
 */
export function setApiInstanceDeps(overrides: Partial<InstanceDeps> | null): void {
  deps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps;
}

export interface AgentInstanceConnectOptions {
  preferNewInstance?: boolean;
}

export interface AgentInstanceConnectResult {
  agentConfigId: string;
  environmentId: string;
  instanceId: string;
  relay: {
    wsUrl: string;
  };
}

interface AgentConfigRecord {
  id: string;
  organizationId?: string | null;
  name: string;
  description?: string | null;
}

function toKebabSegment(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function ensureInternalAgent(agent: AgentConfigRecord | null | undefined, organizationId: string): AgentConfigRecord {
  if (!agent || agent.organizationId !== organizationId) {
    throw new AppError("Agent not found", "NOT_FOUND", 404);
  }
  return agent;
}

function pickEnvironment(
  environments: EnvironmentRecord[],
  activeMap: Map<string, Array<{ status: string }>>,
): EnvironmentRecord | null {
  if (environments.length === 0) return null;
  const running = environments.find((env) => {
    const instances = activeMap.get(env.id) ?? [];
    return instances.some((instance) => instance.status === "running" || instance.status === "starting");
  });
  return running ?? environments[0] ?? null;
}

/**
 * 将 AgentConfig 解析为一个可连接的 instance 入口，必要时自动创建 environment / 启动 instance。
 */
export async function connectAgentInstance(
  ctx: AuthContext,
  agentConfigId: string,
  options: AgentInstanceConnectOptions = {},
): Promise<AgentInstanceConnectResult> {
  const agent = ensureInternalAgent(
    (await deps.getAgentConfigById(agentConfigId, ctx.organizationId)) as AgentConfigRecord | null,
    ctx.organizationId,
  );

  const activeMap = deps.groupActiveInstancesByEnvironment();
  const existingEnvironments = (await deps.listEnvironmentsByOrganizationId(ctx.organizationId)).filter(
    (env) => env.agentConfigId === agent.id,
  );
  let environment = pickEnvironment(existingEnvironments, activeMap);

  if (!environment) {
    const base = toKebabSegment(agent.name) || "agent";
    environment = await deps.createWebEnvironment({
      name: `runtime-${base}-${agent.id.slice(0, 8)}`,
      description: agent.description ?? undefined,
      agentConfigId: agent.id,
      autoStart: true,
      userId: ctx.userId,
      organizationId: ctx.organizationId,
    });
  }

  const runningInstances = deps.getRunningInstancesByEnvironment(environment.id);
  const instance =
    !options.preferNewInstance && runningInstances[0]
      ? runningInstances[0]
      : await deps.spawnInstanceFromEnvironment(ctx.userId, environment.id, environment);

  return {
    agentConfigId: agent.id,
    environmentId: environment.id,
    instanceId: instance.id,
    relay: { wsUrl: `/acp/relay/${environment.id}` },
  };
}
