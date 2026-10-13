import { AppError } from "@fenix/platform-sdk";
import { type EnvironmentRecord, environmentRepo } from "../repositories/environment";
import {
  type AgentConfigLookupPort,
  type AgentConfigLookupResult,
  getAgentConfigLookupPort,
} from "./agent-config-lookup-port";
import { agentInstanceService } from "./agent-instance-service";
import { createWebEnvironment } from "./environment-web";

type InstanceDeps = {
  createWebEnvironment: typeof createWebEnvironment;
  /** 按真实用户身份的组织可见性读 Agent 配置投影（端口动词，替代旧的 `getReadableAgentConfigById`）。 */
  findVisibleAgentConfig: AgentConfigLookupPort["findVisibleAgentConfig"];
  resolveInstance: typeof agentInstanceService.resolveInstanceForOperation;
  ensureInstanceRuntime: typeof agentInstanceService.ensureInstanceRuntime;
  listEnvironmentsByOrganizationId: typeof environmentRepo.listByOrganizationId;
};

const defaultDeps: InstanceDeps = {
  createWebEnvironment,
  findVisibleAgentConfig: (input) => getAgentConfigLookupPort().findVisibleAgentConfig(input),
  resolveInstance: agentInstanceService.resolveInstanceForOperation.bind(agentInstanceService),
  ensureInstanceRuntime: agentInstanceService.ensureInstanceRuntime.bind(agentInstanceService),
  listEnvironmentsByOrganizationId: async (organizationId: string) =>
    environmentRepo.listByOrganizationId(organizationId),
};

let deps: InstanceDeps = defaultDeps;

/**
 * 测试覆盖 instance service 依赖，避免路由测试触达真实 DB 和 runtime。
 */
export function setApiInstanceDeps(overrides: Partial<InstanceDeps> | null): void {
  if (!overrides) {
    deps = defaultDeps;
    return;
  }
  deps = { ...deps, ...overrides };
}

export interface AgentInstanceConnectOptions {
  instanceUid?: string;
}

export interface AgentInstanceConnectResult {
  agentConfigId: string;
  environmentId: string;
  instanceId: string;
  relay: {
    wsUrl: string;
  };
}

/** 连接入口只认「谁、在哪个组织」，不再接受角色——可见性判定由端口按真实成员关系完成（§9.1）。 */
export interface InstanceOwner {
  readonly organizationId: string;
  readonly userId: string;
}

function toKebabSegment(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function ensureReadableAgent(agent: AgentConfigLookupResult | null | undefined): AgentConfigLookupResult {
  if (!agent) {
    throw new AppError("Agent not found", "NOT_FOUND", 404);
  }
  return agent;
}

function pickEnvironment(environments: EnvironmentRecord[]): EnvironmentRecord | null {
  return environments[0] ?? null;
}

/**
 * 将 AgentConfig 解析为一个可连接的 instance 入口，必要时自动创建 environment / 启动 instance。
 */
export async function connectAgentInstance(
  ctx: InstanceOwner,
  agentConfigId: string,
  options: AgentInstanceConnectOptions = {},
): Promise<AgentInstanceConnectResult> {
  const agent = ensureReadableAgent(
    await deps.findVisibleAgentConfig({
      agentConfigId,
      organizationId: ctx.organizationId,
      userId: ctx.userId,
    }),
  );

  const existingEnvironments = (await deps.listEnvironmentsByOrganizationId(ctx.organizationId)).filter(
    (env) => env.agentConfigId === agent.id && env.userId === ctx.userId,
  );
  let environment = pickEnvironment(existingEnvironments);

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

  const instance = await deps.resolveInstance({
    environmentId: environment.id,
    ownerUserId: ctx.userId,
    requestedInstanceUid: options.instanceUid,
    automaticSelection: "api",
  });
  await deps.ensureInstanceRuntime(instance);
  const instanceId = instance.id;

  return {
    agentConfigId: agent.id,
    environmentId: environment.id,
    instanceId,
    // instanceId 附带为 query：/acp/relay 端点多实例环境下据此精确连接，
    // 避免「第一个 running 实例」歧义；不带 query 的旧式直连仍有 fallback。
    relay: { wsUrl: `/acp/relay/${environment.id}?instanceId=${instanceId}` },
  };
}
