import { AppError } from "../errors";
import type { AuthContext } from "../plugins/auth";
import { type EnvironmentRecord, environmentRepo } from "../repositories/environment";
import { getReadableAgentConfigById } from "./config";
import { createWebEnvironment } from "./environment-web";
import { getRunningInstancesByEnvironment, groupActiveInstancesByEnvironment } from "./instance";
import { spawnInstanceViaController } from "./orchestration-instance";

type InstanceDeps = {
  createWebEnvironment: typeof createWebEnvironment;
  getReadableAgentConfigById: typeof getReadableAgentConfigById;
  getRunningInstancesByEnvironment: typeof getRunningInstancesByEnvironment;
  groupActiveInstancesByEnvironment: typeof groupActiveInstancesByEnvironment;
  listEnvironmentsByOrganizationId: typeof environmentRepo.listByOrganizationId;
  spawnInstanceViaController: typeof spawnInstanceViaController;
};

const defaultDeps: InstanceDeps = {
  createWebEnvironment,
  getReadableAgentConfigById,
  getRunningInstancesByEnvironment,
  groupActiveInstancesByEnvironment,
  listEnvironmentsByOrganizationId: async (organizationId: string) =>
    environmentRepo.listByOrganizationId(organizationId),
  spawnInstanceViaController,
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

function ensureReadableAgent(agent: AgentConfigRecord | null | undefined): AgentConfigRecord {
  if (!agent) {
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
  const agent = ensureReadableAgent(
    (await deps.getReadableAgentConfigById(ctx, agentConfigId)) as AgentConfigRecord | null,
  );

  const activeMap = deps.groupActiveInstancesByEnvironment();
  const existingEnvironments = (await deps.listEnvironmentsByOrganizationId(ctx.organizationId)).filter(
    (env) => env.agentConfigId === agent.id && env.userId === ctx.userId,
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
  const runningInstance = !options.preferNewInstance ? runningInstances[0] : undefined;
  const instance = runningInstance
    ? runningInstance
    : await deps.spawnInstanceViaController(environment.id, ctx.userId, "interactive");
  // runningInstance 为旧 SpawnedInstance（.id），spawn 分支为编排域 Instance（.instanceId）
  const instanceId = "id" in instance ? instance.id : instance.instanceId;

  return {
    agentConfigId: agent.id,
    environmentId: environment.id,
    instanceId,
    // instanceId 附带为 query：/acp/relay 端点多实例环境下据此精确连接，
    // 避免「第一个 running 实例」歧义；不带 query 的旧式直连仍有 fallback。
    relay: { wsUrl: `/acp/relay/${environment.id}?instanceId=${instanceId}` },
  };
}
