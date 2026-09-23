import { AppError } from "@fenix/platform-sdk";
import { SERVER_EPOCH } from "@fenix/remote-runtime";
import { createAgentInstanceUid, isAgentInstanceUid } from "../instance/agent-instance-id";
import type { AgentInstanceRecord, IAgentInstanceRepo, InstanceCreationSource } from "../repositories/agent-instance";
import { agentInstanceRepo } from "../repositories/agent-instance";
import {
  AgentInstanceRuntimeCoordinator,
  type RuntimeAdapter,
  type RuntimeSnapshot,
  type RuntimeStopMode,
} from "./agent-instance-runtime-coordinator";
import { getBoundCoreRuntime as getCoreRuntime } from "./core-runtime-port";

export type AutomaticInstanceSelection = "chat" | "api" | "workflow";

/** 持久实例协调器所需的编排操作，由运行时装配层绑定以避免 service 反向依赖编排实现。 */
export interface AgentInstanceRuntimeOperations {
  spawnInstance(
    environmentId: string,
    userId: string,
    source: "interactive" | "scheduled",
    options: { instanceUid: string; runtimeGeneration: number; serverEpoch: string },
  ): Promise<unknown>;
  stopInstance(instanceUid: string, mode: "strict"): Promise<unknown>;
  hasActiveInstance(instanceUid: string): boolean;
}

let runtimeOperations: AgentInstanceRuntimeOperations | null = null;

/** 绑定持久实例生命周期的编排操作；未绑定时启动/停止会以明确错误失败。 */
export function bindAgentInstanceRuntimeOperations(operations: AgentInstanceRuntimeOperations): void {
  runtimeOperations = operations;
}

/** 测试后解绑实例编排操作，避免模块级装配状态泄漏。 */
export function resetAgentInstanceRuntimeOperations(): void {
  runtimeOperations = null;
}

/** 获取已装配的实例编排操作；遗漏宿主装配时显式失败。 */
export function getAgentInstanceRuntimeOperations(): AgentInstanceRuntimeOperations {
  if (!runtimeOperations) throw new Error("Agent instance runtime operations are not bound");
  return runtimeOperations;
}

const SELECTION: Record<
  AutomaticInstanceSelection,
  { source: InstanceCreationSource; name: string; isDefault: boolean }
> = {
  chat: { source: "user", name: "default", isDefault: true },
  api: { source: "api", name: "primary", isDefault: false },
  workflow: { source: "workflow", name: "primary", isDefault: false },
};

const runtimeAdapter: RuntimeAdapter = {
  async start(instance, generation, signal) {
    signal.throwIfAborted();
    const source = instance.creationSource === "workflow" ? "scheduled" : "interactive";
    await getAgentInstanceRuntimeOperations().spawnInstance(instance.environmentId, instance.ownerUserId, source, {
      instanceUid: instance.id,
      runtimeGeneration: generation,
      serverEpoch: SERVER_EPOCH,
    });
  },
  hasActiveRuntime(instanceUid) {
    const coreInstance = getCoreRuntime().getInstance(instanceUid);
    return (
      (coreInstance !== null && coreInstance.status !== "stopped") ||
      getAgentInstanceRuntimeOperations().hasActiveInstance(instanceUid)
    );
  },
  async stopActiveRuntime(instanceUid, signal) {
    signal.throwIfAborted();
    await getAgentInstanceRuntimeOperations().stopInstance(instanceUid, "strict");
  },
  async stop(instanceUid, generation, signal) {
    signal.throwIfAborted();
    const current = getCoreRuntime().getInstance(instanceUid);
    if (current?.runtimeGeneration !== generation || current.serverEpoch !== SERVER_EPOCH) return;
    await getAgentInstanceRuntimeOperations().stopInstance(instanceUid, "strict");
  },
};

/** 持久 Agent Instance 的领域服务。 */
export class AgentInstanceService {
  constructor(
    private readonly repository: IAgentInstanceRepo,
    private readonly coordinator: AgentInstanceRuntimeCoordinator,
  ) {}

  findOrCreateDefaultInstance(environmentId: string, ownerUserId: string): Promise<AgentInstanceRecord> {
    return this.#findOrCreate(environmentId, ownerUserId, "chat");
  }

  findOrCreateApiInstance(environmentId: string, ownerUserId: string): Promise<AgentInstanceRecord> {
    return this.#findOrCreate(environmentId, ownerUserId, "api");
  }

  findOrCreateWorkflowInstance(environmentId: string, ownerUserId: string): Promise<AgentInstanceRecord> {
    return this.#findOrCreate(environmentId, ownerUserId, "workflow");
  }

  findOrCreateWorkflowInstanceWithStatus(
    environmentId: string,
    ownerUserId: string,
  ): Promise<{ instance: AgentInstanceRecord; created: boolean }> {
    return this.#findOrCreateWithStatus(environmentId, ownerUserId, "workflow");
  }

  async createUserInstance(input: {
    environmentId: string;
    ownerUserId: string;
    actorUserId: string;
    name: string;
  }): Promise<AgentInstanceRecord> {
    const name = input.name.trim();
    if (!name || name.length > 100 || name === "default") {
      throw new AppError("Invalid Agent Instance name", "INSTANCE_NAME_INVALID", 400);
    }
    return this.repository.insert({
      id: createAgentInstanceUid(),
      environmentId: input.environmentId,
      ownerUserId: input.ownerUserId,
      creationSource: "user",
      name,
      isDefault: false,
      createdByUserId: input.actorUserId,
    });
  }

  async getOwnedInstance(instanceUid: string, ownerUserId: string): Promise<AgentInstanceRecord> {
    if (!isAgentInstanceUid(instanceUid)) throw this.#notFound();
    const instance = await this.repository.findOwnedById(instanceUid, ownerUserId);
    if (!instance) throw this.#notFound();
    return instance;
  }

  async resolveInstanceForOperation(input: {
    environmentId: string;
    ownerUserId: string;
    requestedInstanceUid?: string;
    automaticSelection: AutomaticInstanceSelection;
  }): Promise<AgentInstanceRecord> {
    if (input.requestedInstanceUid) {
      const instance = await this.getOwnedInstance(input.requestedInstanceUid, input.ownerUserId);
      if (instance.environmentId !== input.environmentId) throw this.#notFound();
      return instance;
    }
    return this.#findOrCreate(input.environmentId, input.ownerUserId, input.automaticSelection);
  }

  getRuntimeSnapshot(instanceUid: string): RuntimeSnapshot {
    return this.coordinator.snapshot(instanceUid);
  }

  handleRuntimeDeath(instanceUid: string, generation: number): void {
    this.coordinator.handleRuntimeDeath(instanceUid, generation);
  }

  handleRuntimeDisconnect(instanceUid: string, generation: number, machineId: string): void {
    this.coordinator.handleRuntimeDisconnect(instanceUid, generation, machineId);
  }

  /** 机器确认 clean slate 后解除该机器断连造成的 unknown;返回被复位的实例 uid。 */
  handleMachineCleanSlate(machineId: string): string[] {
    return this.coordinator.handleMachineCleanSlate(machineId);
  }

  shutdownRuntimes(): Promise<void> {
    return this.coordinator.shutdown();
  }

  async ensureInstanceRuntime(instance: AgentInstanceRecord, signal?: AbortSignal): Promise<void> {
    await this.coordinator.ensureRuntime(instance, signal);
  }

  async stopInstanceRuntime(instance: AgentInstanceRecord, mode: RuntimeStopMode = "strict"): Promise<void> {
    await this.coordinator.stopRuntime(instance, mode);
  }

  async restartInstanceRuntime(instance: AgentInstanceRecord): Promise<void> {
    await this.coordinator.restartRuntime(instance);
  }

  /** 重启指定 Environment 下当前运行中或启动中的持久 Instance，与实例列表 Restart 按钮的目标判定一致。 */
  async restartActiveInstancesForEnvironments(environmentIds: string[]): Promise<string[]> {
    const instances = (
      await Promise.all(
        [...new Set(environmentIds)].map((environmentId) => this.repository.listByEnvironment(environmentId)),
      )
    ).flat();
    const activeInstances = instances.filter((instance) => {
      const state = this.coordinator.snapshot(instance.id).state;
      return state === "running" || state === "starting";
    });
    await Promise.all(activeInstances.map((instance) => this.restartInstanceRuntime(instance)));
    return activeInstances.map((instance) => instance.id);
  }

  async deleteInstance(instance: AgentInstanceRecord): Promise<void> {
    if (instance.isDefault)
      throw new AppError("Default Agent Instance cannot be deleted", "DEFAULT_INSTANCE_DELETE_DENIED", 409);
    await this.coordinator.deleteRuntime(instance);
    const deleteGeneration = this.coordinator.snapshot(instance.id).runtimeGeneration;
    try {
      const deleted = await this.repository.deleteById(instance.id);
      if (!deleted) throw this.#notFound();
    } catch (error) {
      this.coordinator.recoverDelete(instance.id, deleteGeneration);
      throw error;
    }
  }

  async listInstances(
    ownerUserId: string,
    environmentId?: string,
  ): Promise<Array<AgentInstanceRecord & { runtime: RuntimeSnapshot }>> {
    const instances = await this.repository.listByOwner(ownerUserId, environmentId);
    return instances.map((instance) => ({ ...instance, runtime: this.coordinator.snapshot(instance.id) }));
  }

  async #findOrCreateWithStatus(
    environmentId: string,
    ownerUserId: string,
    selection: AutomaticInstanceSelection,
  ): Promise<{ instance: AgentInstanceRecord; created: boolean }> {
    if (!ownerUserId) throw new AppError("Agent Instance owner is required", "INSTANCE_OWNER_REQUIRED", 400);
    const key = SELECTION[selection];
    const existing = await this.repository.findByCreationKey(environmentId, ownerUserId, key.source, key.name);
    if (existing) return { instance: existing, created: false };
    const instance = await this.repository.findOrCreateByCreationKey({
      id: createAgentInstanceUid(),
      environmentId,
      ownerUserId,
      creationSource: key.source,
      name: key.name,
      isDefault: key.isDefault,
      createdByUserId: ownerUserId,
    });
    return { instance, created: true };
  }

  async #findOrCreate(
    environmentId: string,
    ownerUserId: string,
    selection: AutomaticInstanceSelection,
  ): Promise<AgentInstanceRecord> {
    if (!ownerUserId) throw new AppError("Agent Instance owner is required", "INSTANCE_OWNER_REQUIRED", 400);
    const key = SELECTION[selection];
    return this.repository.findOrCreateByCreationKey({
      id: createAgentInstanceUid(),
      environmentId,
      ownerUserId,
      creationSource: key.source,
      name: key.name,
      isDefault: key.isDefault,
      createdByUserId: ownerUserId,
    });
  }

  #notFound(): AppError {
    return new AppError("Agent Instance not found", "INSTANCE_NOT_FOUND", 404);
  }
}

export const agentInstanceRuntimeCoordinator = new AgentInstanceRuntimeCoordinator(runtimeAdapter);
export const agentInstanceService = new AgentInstanceService(agentInstanceRepo, agentInstanceRuntimeCoordinator);
