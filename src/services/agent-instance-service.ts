import { SERVER_EPOCH } from "@fenix/remote-runtime";
import { AppError } from "../errors";
import type { AgentInstanceRecord, IAgentInstanceRepo, InstanceCreationSource } from "../repositories";
import { agentInstanceRepo } from "../repositories";
import { createAgentInstanceUid, isAgentInstanceUid } from "./agent-instance-id";
import {
  AgentInstanceRuntimeCoordinator,
  type RuntimeAdapter,
  type RuntimeSnapshot,
  type RuntimeStopMode,
} from "./agent-instance-runtime-coordinator";
import { getCoreRuntime } from "./core-bootstrap";
import { spawnInstanceViaController, stopInstanceViaController } from "./orchestration-instance";

export type AutomaticInstanceSelection = "chat" | "api" | "workflow";

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
    await spawnInstanceViaController(instance.environmentId, instance.ownerUserId, source, {
      instanceUid: instance.id,
      runtimeGeneration: generation,
      serverEpoch: SERVER_EPOCH,
    });
  },
  async stop(instanceUid, generation, signal) {
    signal.throwIfAborted();
    const current = getCoreRuntime().getInstance(instanceUid);
    if (current?.runtimeGeneration !== generation || current.serverEpoch !== SERVER_EPOCH) return;
    await stopInstanceViaController(instanceUid, "strict");
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

  handleRuntimeDisconnect(instanceUid: string, generation: number): void {
    this.coordinator.handleRuntimeDisconnect(instanceUid, generation);
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

  /** 重启指定 Environment 下当前正在运行或启动中的持久 Instance，保留其持久身份。 */
  async restartRunningInstancesForEnvironments(environmentIds: string[]): Promise<string[]> {
    const instances = (
      await Promise.all(
        [...new Set(environmentIds)].map((environmentId) => this.repository.listByEnvironment(environmentId)),
      )
    ).flat();
    const running = instances.filter((instance) => {
      const state = this.coordinator.snapshot(instance.id).state;
      return state === "running" || state === "starting";
    });
    await Promise.all(running.map((instance) => this.coordinator.restartRuntime(instance)));
    return running.map((instance) => instance.id);
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
