import { randomUUID } from "node:crypto";
import { AppError } from "@fenix/platform-sdk";
import { runInTransaction } from "@fenix/platform-sdk/server";
import { type AgentInstanceRecord, agentInstanceRepo } from "../server/repositories/agent-instance";
import {
  type EnvironmentCreateParams,
  type EnvironmentRecord,
  environmentRepo,
} from "../server/repositories/environment";
import { getAgentConfigLookupPort } from "../server/services/agent-config-lookup-port";
import { agentInstanceService } from "../server/services/agent-instance-service";
import type { InstanceOwner } from "../server/services/api-instance-resolution";
import { getBoundCoreRuntime } from "../server/services/core-runtime-port";
import {
  isTemporaryEnvironment,
  type TemporaryEnvironmentLifecycle,
} from "../server/services/temporary-environment-lifecycle";
import {
  getTemporaryEnvironmentMaxTtl,
  scheduleTemporaryEnvironmentExpiry,
  temporaryEnvironmentLifecycle,
} from "../server/services/temporary-environment-state";
import { generateEnvSecret, getOwnedEnvironment } from "../services/environment-core";

/** 临时环境应用编排端口；域服务不接收 actor。 */
export interface TemporaryEnvironmentDependencies {
  findAgent(owner: InstanceOwner, agentId: string): Promise<{ id: string } | null>;
  ttl(agentId: string): Promise<number>;
  createEnvironment(input: EnvironmentCreateParams): Promise<EnvironmentRecord>;
  getOwnedEnvironment(id: string, owner: InstanceOwner): Promise<EnvironmentRecord>;
  createInstance(environmentId: string, userId: string): Promise<AgentInstanceRecord>;
  findInstance(environmentId: string, userId: string): Promise<AgentInstanceRecord | undefined>;
  ensureRuntime(instance: AgentInstanceRecord, signal?: AbortSignal): Promise<void>;
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  schedule(id: string, expiresAt: Date, instanceId: string): void;
  lifecycle: TemporaryEnvironmentLifecycle;
}
/** 创建事务提交后确认新实例尚无 Runtime，使来源证明与实例生命周期一起保留。 */
export function registerCreatedTemporaryEnvironment(id: string, expiresAt: Date, instanceId: string): void {
  // 提交后其他连接已能发现实例；冷启动证明不能覆盖先行连接占用的运行代次。
  const runtime = agentInstanceService.getRuntimeSnapshot(instanceId);
  if (
    runtime.runtimeGeneration === 0 &&
    runtime.operationId === 0 &&
    runtime.state === "stopped" &&
    runtime.currentOperation === null &&
    !runtime.deleting &&
    !getBoundCoreRuntime().getInstance(instanceId)
  )
    agentInstanceService.handleRuntimeTerminated({ instanceUids: [instanceId] });
  scheduleTemporaryEnvironmentExpiry(id, expiresAt);
}
const defaults: TemporaryEnvironmentDependencies = {
  findAgent: (owner, agentConfigId) =>
    getAgentConfigLookupPort().findVisibleAgentConfig({ ...owner, agentConfigId, action: "use" }),
  ttl: async (id) => {
    const read = getAgentConfigLookupPort().getEnvironmentTtl;
    if (!read) throw new Error("Environment policy reader is not bound");
    return read(id, getTemporaryEnvironmentMaxTtl());
  },
  createEnvironment: (input) => environmentRepo.create(input),
  getOwnedEnvironment: (id, owner) => getOwnedEnvironment(id, owner.organizationId, owner.userId),
  createInstance: (id, userId) => agentInstanceService.findOrCreateApiInstance(id, userId),
  findInstance: (id, userId) => agentInstanceRepo.findByCreationKey(id, userId, "api", "api"),
  ensureRuntime: (instance, signal) => agentInstanceService.ensureInstanceRuntime(instance, signal, "explicit"),
  transaction: runInTransaction,
  schedule: registerCreatedTemporaryEnvironment,
  lifecycle: temporaryEnvironmentLifecycle,
};
/** 临时 Environment 的授权、事务创建及显式续期应用入口。 */
export class TemporaryEnvironmentFacade {
  constructor(private readonly deps: TemporaryEnvironmentDependencies = defaults) {}
  /** 仅事务创建临时环境与非默认 API 实例；目录及引擎配置沿原启动流程准备。 */
  async create(owner: InstanceOwner, agentId: string) {
    if (!(await this.deps.findAgent(owner, agentId))) throw new AppError("Agent not found", "NOT_FOUND", 404);
    const ttl = await this.deps.ttl(agentId);
    const expiresAt = new Date(Date.now() + ttl * 1000);
    const id = `temp-${randomUUID()}`;
    const instance = await this.deps.transaction(async () => {
      await this.deps.createEnvironment({
        id,
        name: id,
        agentConfigId: agentId,
        userId: owner.userId,
        organizationId: owner.organizationId,
        autoStart: false,
        status: "idle",
        workspacePath: "",
        secret: generateEnvSecret(),
        expiresAt,
      });
      return this.deps.createInstance(id, owner.userId);
    });
    this.deps.schedule(id, expiresAt, instance.id);
    return { environmentId: id, instanceId: instance.id, expiresAt: expiresAt.toISOString() };
  }
  /** 归属与 Agent use 均重新验证；到期允许续期，原实例身份保持。 */
  async renew(owner: InstanceOwner, id: string, signal?: AbortSignal) {
    const environment = await this.deps.getOwnedEnvironment(id, owner);
    if (
      !isTemporaryEnvironment(id) ||
      !environment.agentConfigId ||
      !(await this.deps.findAgent(owner, environment.agentConfigId))
    )
      throw new AppError("Environment not found", "NOT_FOUND", 404);
    const instance = await this.deps.findInstance(id, owner.userId);
    if (!instance) throw new AppError("Instance not found", "NOT_FOUND", 404);
    const ttl = await this.deps.ttl(environment.agentConfigId);
    const expiresAt = await this.deps.lifecycle.renew(id, ttl, async () => {
      await this.deps.ensureRuntime(instance, signal);
    });
    return {
      environmentId: id,
      instanceId: instance.id,
      expiresAt: expiresAt.toISOString(),
      status: "running" as const,
    };
  }
}
