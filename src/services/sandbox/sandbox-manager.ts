import { createLogger } from "@fenix/logger";
import type {
  SandboxCreateInput,
  SandboxProvider,
  SandboxRef,
  SandboxResourceOverrides,
  SandboxResources,
  SandboxTemplate,
} from "@fenix/sandbox-provider";
import type { SandboxInstance, SandboxPool } from "../../db/schema";
import { isMachineOnline } from "../../repositories/machine-repository";
import type { SandboxInstanceLockScope } from "../../repositories/sandbox-instance-repository";
import {
  createSandboxInstance,
  deleteSandboxInstance,
  findActiveSandboxInstance,
  findSandboxInstanceById,
  findSandboxInstanceByIdForUser,
  listSandboxInstances,
  updateSandboxInstance,
  withSandboxInstanceLock,
} from "../../repositories/sandbox-instance-repository";
import { findReadableSandboxPoolById, findSandboxPoolById } from "../../repositories/sandbox-pool-repository";
import { unregisterRemoteNode } from "../core-bootstrap";
import { createSandboxMachine } from "../registry";
import { stopHeartbeat } from "../registry-heartbeat";
import {
  getProviderExtra,
  getSandboxAgentType,
  parseSandboxResources,
  resolveSandboxConfig,
  type SandboxResolvedConfig,
  sandboxConfigsEqual,
} from "./sandbox-config";
import { SandboxInstanceConflictError, type SandboxInstanceStatus, SandboxStateError } from "./sandbox-errors";
import type { SandboxProviderRegistry } from "./sandbox-provider-registry";

const logger = createLogger("sandbox-manager");

type SandboxPoolRepository = {
  findById(id: string): Promise<SandboxPool | null>;
  findReadableById?(id: string, organizationId: string): Promise<SandboxPool | null>;
};

type SandboxInstanceRepository = {
  findActive(providerKey: string, poolId: string, userId: string): Promise<SandboxInstance | null>;
  findById?(id: string): Promise<SandboxInstance | null>;
  findByIdForUser(id: string, userId: string): Promise<SandboxInstance | null>;
  create(input: Parameters<typeof createSandboxInstance>[0]): Promise<SandboxInstance>;
  update(
    id: string,
    status: string,
    patch?: Parameters<typeof updateSandboxInstance>[2],
  ): Promise<SandboxInstance | null>;
  delete?(id: string): Promise<SandboxInstance | null>;
  list?: (filters?: {
    sandboxPoolId?: string;
    instanceIds?: string[];
    userIds?: string[];
  }) => Promise<SandboxInstance[]>;
  withLock?: <T>(id: string, operation: (scope: SandboxInstanceLockScope) => Promise<T>) => Promise<T>;
};

type SandboxAdminResourceOverrides = {
  cpu?: number | null;
  memoryMb?: number | null;
  diskGb?: number | null;
  gpuCount?: number | null;
};

export type SandboxManagerDependencies = {
  pools?: SandboxPoolRepository;
  instances?: SandboxInstanceRepository;
  providers: SandboxProviderRegistry;
  now?: () => Date;
  isMachineOnline?: (machineId: string) => Promise<boolean>;
};

export type SandboxManagerCreateInput = {
  sandboxId: string;
  poolId: string;
  providerKey: string;
  userId: string;
  template: SandboxTemplate;
  resources?: SandboxResources;
  resourceOverrides?: SandboxResourceOverrides | null;
  organizationId?: string | null;
  agentName?: string;
};

function asResources(value: unknown): SandboxResources {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SandboxStateError("sandbox pool default resources are invalid");
  }
  const resources = value as Partial<SandboxResources>;
  if (
    typeof resources.cpu !== "number" ||
    typeof resources.memoryMb !== "number" ||
    typeof resources.diskGb !== "number" ||
    typeof resources.gpuCount !== "number" ||
    !resources.environment ||
    !Array.isArray(resources.volumes)
  ) {
    throw new SandboxStateError("sandbox pool default resources are incomplete");
  }
  return resources as SandboxResources;
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown; cause?: unknown };
  return (
    candidate.code === "23505" ||
    (typeof candidate.message === "string" &&
      (candidate.message.includes("duplicate key") || candidate.message.includes("unique constraint"))) ||
    isUniqueConstraintError(candidate.cause)
  );
}

function sandboxMachineId(sandboxId: string): string {
  return `mach_sandbox_${sandboxId}`;
}

function addMachineIdToConfig(config: SandboxResolvedConfig, machineId: string): SandboxResolvedConfig {
  return {
    ...config,
    resources: {
      ...config.resources,
      environment: { ...config.resources.environment, RCS_MACHINE_ID: machineId },
    },
  };
}

export class SandboxManager {
  private readonly pools: SandboxPoolRepository;
  private readonly instances: SandboxInstanceRepository;
  private readonly now: () => Date;
  private readonly isMachineOnline: (machineId: string) => Promise<boolean>;

  constructor(private readonly dependencies: SandboxManagerDependencies) {
    this.pools = dependencies.pools ?? {
      findById: findSandboxPoolById,
      findReadableById: findReadableSandboxPoolById,
    };
    this.instances = dependencies.instances ?? {
      findActive: findActiveSandboxInstance,
      findById: findSandboxInstanceById,
      findByIdForUser: findSandboxInstanceByIdForUser,
      create: createSandboxInstance,
      update: updateSandboxInstance,
      delete: deleteSandboxInstance,
      list: listSandboxInstances,
      withLock: withSandboxInstanceLock,
    };
    this.now = dependencies.now ?? (() => new Date());
    this.isMachineOnline = dependencies.isMachineOnline ?? isMachineOnline;
  }

  async createOrReuse(input: SandboxManagerCreateInput): Promise<SandboxInstance> {
    const pool =
      input.organizationId && this.pools.findReadableById
        ? await this.pools.findReadableById(input.poolId, input.organizationId)
        : await this.pools.findById(input.poolId);
    if (!pool) throw new SandboxStateError(`sandbox pool '${input.poolId}' not found`);
    if (pool.providerKey !== input.providerKey) {
      throw new SandboxStateError(`sandbox provider '${input.providerKey}' does not match pool '${input.poolId}'`);
    }

    const existing = await this.instances.findActive(input.providerKey, input.poolId, input.userId);
    if (existing) return this.reconcileWithLock(existing);

    const createdAt = this.now();
    const machineId = sandboxMachineId(input.sandboxId);
    const baseResolvedConfig = resolveSandboxConfig(
      pool.image ?? input.template.value,
      asResources(pool.defaultResources),
      input.resourceOverrides,
      getProviderExtra(pool.extra, input.providerKey),
      input.userId,
    );
    const resolvedConfig = addMachineIdToConfig(baseResolvedConfig, machineId);

    // 先插入 sandbox_instance，用唯一索引原子抢占“同一用户/资源池只能有一个活跃实例”的创建权。
    // machine 和 provider 资源都必须在抢占成功后创建，避免失败请求留下孤儿 machine。
    let instance: SandboxInstance;
    try {
      instance = await this.instances.create({
        id: input.sandboxId,
        machineId,
        providerKey: input.providerKey,
        sandboxPoolId: input.poolId,
        userId: input.userId,
        externalSandboxId: null,
        status: "creating",
        resolvedConfig,
        resourceOverrides: input.resourceOverrides ?? null,
        providerPayload: null,
        lastHeartbeatAt: null,
        createdAt,
        updatedAt: createdAt,
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        // 并发创建冲突：复用抢占成功的一方；machine 和 provider 资源均由持有记录的一方创建。
        const concurrent = await this.instances.findActive(input.providerKey, input.poolId, input.userId);
        if (concurrent) return this.reconcileWithLock(concurrent);
        // 冲突但查不到并发实例（极端竞态）：按冲突上报
        throw new SandboxInstanceConflictError(
          error instanceof Error ? error.message : "sandbox instance create conflicted",
        );
      }
      // 非唯一索引冲突的失败（FK 缺失、DB 连接错误等）保留原始错误：
      // 原实现一律包 SandboxInstanceConflictError 会把 DB 故障误报为"冲突"、误导排障
      throw error instanceof Error ? error : new Error(String(error));
    }

    // 新记录虽然已经插入，但 machine/provider 仍未创建；reconcileWithLock 会先锁住
    // 这条记录，再完成 machine → provider → externalSandboxId 的完整初始化流程。
    return this.reconcileWithLock(instance, {
      createMachine: async () => {
        await createSandboxMachine({
          id: machineId,
          organizationId: input.organizationId ?? null,
          userId: input.userId,
          agentName: input.agentName ?? getSandboxAgentType(pool.extra),
        });
      },
    });
  }

  async getPool(id: string, organizationId?: string): Promise<SandboxPool> {
    const pool =
      organizationId && this.pools.findReadableById
        ? await this.pools.findReadableById(id, organizationId)
        : await this.pools.findById(id);
    if (!pool) throw new SandboxStateError(`sandbox pool '${id}' not found`);
    return pool;
  }

  async markReady(sandboxId: string): Promise<SandboxInstance> {
    const instance = await this.instances.update(sandboxId, "ready", { lastHeartbeatAt: this.now() });
    if (!instance) throw new SandboxStateError(`sandbox instance '${sandboxId}' not found`);
    return instance;
  }

  async markError(sandboxId: string, payload?: unknown): Promise<SandboxInstance> {
    const instance = await this.instances.update(
      sandboxId,
      "error",
      payload === undefined ? {} : { providerPayload: payload },
    );
    if (!instance) throw new SandboxStateError(`sandbox instance '${sandboxId}' not found`);
    return instance;
  }

  /** ACP 等待超时后，优先复用原 Provider 资源恢复连接，不主动销毁资源。 */
  async restart(sandboxId: string): Promise<SandboxInstance> {
    const instance = await this.instances.findById?.(sandboxId);
    if (!instance) throw new SandboxStateError(`sandbox instance '${sandboxId}' not found`);
    if (!instance.externalSandboxId) {
      throw new SandboxStateError(`sandbox instance '${sandboxId}' has no provider resource to restart`);
    }

    const provider = this.dependencies.providers.get(instance.providerKey);
    const ref = await provider.get(instance.externalSandboxId, instance.id);
    if (!ref) {
      throw new SandboxStateError(`provider resource '${instance.externalSandboxId}' was not found`);
    }
    logger.info(
      `[restart] provider result sandboxId='${instance.id}' providerSandboxId='${ref.sandboxId}' providerStatus='${ref.status}'`,
    );
    if (ref.status === "error") {
      throw new SandboxStateError(`provider resource '${ref.sandboxId}' is not recoverable`);
    }
    if (ref.status === "stopped") {
      logger.info(`[restart] provider resource stopped, resuming sandboxId='${instance.id}'`);
      return this.resumeRemote(instance, provider, ref);
    }

    // creating/ready 资源仍然有效，只需重新等待其 ACP runtime 回连。
    return this.saveProviderRef(instance.id, ref);
  }

  /** ACP 等待多次失败且原 Provider 资源无法恢复时，按 Instance 配置快照重建。 */
  async recover(sandboxId: string): Promise<SandboxInstance> {
    const recoverLocked = async (scope: SandboxInstanceLockScope): Promise<SandboxInstance> => {
      const instance = await scope.findById(sandboxId);
      if (!instance) throw new SandboxStateError(`sandbox instance '${sandboxId}' not found`);
      logger.warn(
        `[recover] ACP connection timeout, recreating provider resource sandboxId='${instance.id}' status='${instance.status}' externalSandboxId='${instance.externalSandboxId ?? ""}'`,
      );
      return this.recreateRemote(instance, scope);
    };

    if (this.instances.withLock) return this.instances.withLock(sandboxId, recoverLocked);
    const instance = await this.instances.findById?.(sandboxId);
    if (!instance) throw new SandboxStateError(`sandbox instance '${sandboxId}' not found`);
    logger.warn(
      `[recover] ACP connection timeout, recreating provider resource sandboxId='${instance.id}' status='${instance.status}' externalSandboxId='${instance.externalSandboxId ?? ""}'`,
    );
    return this.recreateRemote(instance);
  }

  async getForUser(id: string, userId: string): Promise<SandboxInstance | null> {
    return this.instances.findByIdForUser(id, userId);
  }

  /** 主动销毁 Provider 资源、移除 Machine 连接路由并删除 Instance 记录。 */
  async deleteForUser(id: string, userId: string): Promise<void> {
    const instance = await this.instances.findByIdForUser(id, userId);
    if (!instance) return;

    try {
      await this.destroyProviderResource(instance);
      if (!this.instances.delete) throw new SandboxStateError("sandbox instance delete is not configured");
      await this.instances.delete(id);
    } catch (error) {
      await this.instances.update(id, "error", {
        providerPayload: {
          reason: "sandbox_delete_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
  }

  /** FenixAgent 重启后将仍需恢复的实例标记为 recovering，保留原 machine_id。 */
  async recoverAfterRestart(): Promise<void> {
    const instances = (await this.instances.list?.()) ?? [];
    for (const instance of instances) {
      if (!["creating", "starting", "ready"].includes(instance.status)) continue;
      await this.instances.update(instance.id, "recovering", {
        providerPayload: { reason: "fenixagent_restart", previousStatus: instance.status },
      });
    }
  }

  /** 修改实例资源覆盖值；配置快照变化时先销毁旧资源，再保留实例为 stopped。 */
  async updateInstanceConfig(
    id: string,
    resourceOverrides: SandboxResourceOverrides | SandboxAdminResourceOverrides | null,
  ): Promise<SandboxInstance> {
    const instance = await this.instances.findById?.(id);
    if (!instance) throw new SandboxStateError(`sandbox instance '${id}' not found`);
    const pool = await this.getPool(instance.sandboxPoolId);
    const mergedResourceOverrides =
      resourceOverrides === null ? null : { ...(instance.resourceOverrides ?? {}), ...resourceOverrides };
    const nonNullResourceOverrides = mergedResourceOverrides
      ? Object.fromEntries(Object.entries(mergedResourceOverrides).filter(([, value]) => value !== null))
      : null;
    const nextResourceOverrides =
      nonNullResourceOverrides && Object.keys(nonNullResourceOverrides).length > 0
        ? (nonNullResourceOverrides as SandboxResourceOverrides)
        : null;
    const nextConfig = addMachineIdToConfig(
      resolveSandboxConfig(
        pool.image,
        asResources(pool.defaultResources),
        nextResourceOverrides,
        getProviderExtra(pool.extra, instance.providerKey),
        instance.userId,
      ),
      instance.machineId,
    );
    const changed = !sandboxConfigsEqual(instance.resolvedConfig, nextConfig);
    if (!changed) {
      const updated = await this.instances.update(id, instance.status, {
        resourceOverrides: nextResourceOverrides,
        resolvedConfig: nextConfig,
      });
      if (!updated) throw new SandboxStateError(`sandbox instance '${id}' not found`);
      return updated;
    }

    try {
      await this.destroyProviderResource(instance);
      const updated = await this.instances.update(id, "stopped", {
        externalSandboxId: null,
        providerPayload: null,
        resourceOverrides: nextResourceOverrides,
        resolvedConfig: nextConfig,
      });
      if (!updated) throw new SandboxStateError(`sandbox instance '${id}' not found`);
      return updated;
    } catch (error) {
      await this.instances.update(id, "error", {
        providerPayload: {
          reason: "sandbox_update_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
  }

  /** 按资源池最新默认值重建选定实例的配置快照和 Provider 资源。 */
  async rebuildInstances(input: {
    sandboxPoolId: string;
    instanceIds?: string[];
    userIds?: string[];
    dryRun?: boolean;
  }): Promise<{
    items: Array<{
      instanceId: string;
      changed: boolean;
      previousConfig: unknown;
      nextConfig: unknown;
      error?: string;
    }>;
  }> {
    if (input.instanceIds?.length && input.userIds?.length) {
      throw new SandboxStateError("instanceIds and userIds cannot both be non-empty");
    }
    const pool = await this.getPool(input.sandboxPoolId);
    const instances =
      (await this.instances.list?.({
        sandboxPoolId: input.sandboxPoolId,
        instanceIds: input.instanceIds,
        userIds: input.userIds,
      })) ?? [];
    const items: Array<{
      instanceId: string;
      changed: boolean;
      previousConfig: unknown;
      nextConfig: unknown;
      error?: string;
    }> = [];

    for (const instance of instances) {
      const nextConfig = addMachineIdToConfig(
        resolveSandboxConfig(
          pool.image,
          asResources(pool.defaultResources),
          instance.resourceOverrides as SandboxResourceOverrides | null,
          getProviderExtra(pool.extra, instance.providerKey),
          instance.userId,
        ),
        instance.machineId,
      );
      const changed = !sandboxConfigsEqual(instance.resolvedConfig, nextConfig);
      const item = { instanceId: instance.id, changed, previousConfig: instance.resolvedConfig, nextConfig };
      if (!changed) {
        continue;
      }
      if (input.dryRun) {
        items.push(item);
        continue;
      }

      try {
        await this.destroyProviderResource(instance);
        await this.instances.update(instance.id, "stopped", {
          externalSandboxId: null,
          providerPayload: null,
          resolvedConfig: nextConfig,
        });
        items.push(item);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.instances.update(instance.id, "error", { providerPayload: { message } });
        items.push({ ...item, error: message });
      }
    }
    return { items };
  }

  private async reconcileExisting(instance: SandboxInstance): Promise<SandboxInstance> {
    return this.reconcileExistingWithRepository(instance, this.instances);
  }

  /**
   * 协调同一个 sandbox_instance 的所有启动请求。
   *
   * 调用方传入的 instance 只是未加锁前的快照，不能直接据此决定是否 createRemote。
   * 必须先 SELECT FOR UPDATE，再重新读取最新记录；否则两个请求都可能看到
   * externalSandboxId=null，并同时创建两个 provider Sandbox。
   *
   * 锁会覆盖 provider.get/create/resume/recreate 以及 externalSandboxId 回写，
   * 让后续请求在拿到锁后只复用第一个请求已经持久化的资源。首次创建时，
   * createMachine 也放在同一锁内，保证 machine 与 provider 初始化不会被并发穿插。
   */
  private async reconcileWithLock(
    instance: SandboxInstance,
    options?: { createMachine?: () => Promise<void> },
  ): Promise<SandboxInstance> {
    if (!this.instances.withLock) {
      // 仅保留给未注入完整 repository 的单元测试；生产默认 repository 始终提供数据库锁。
      await options?.createMachine?.();
      return options?.createMachine ? this.createRemote(instance) : this.reconcileExisting(instance);
    }
    return this.instances.withLock(instance.id, async (scope) => {
      try {
        await options?.createMachine?.();
      } catch (error) {
        await scope.delete(instance.id);
        throw error;
      }
      const locked = await scope.findById(instance.id);
      if (!locked) throw new SandboxStateError(`sandbox instance '${instance.id}' not found`);
      if (options?.createMachine) return this.createRemote(locked, scope);
      return this.reconcileExistingWithRepository(locked, scope);
    });
  }

  private async reconcileExistingWithRepository(
    instance: SandboxInstance,
    repository: Pick<SandboxInstanceLockScope, "update">,
  ): Promise<SandboxInstance> {
    // 这里使用锁内重新读取的快照，并将所有状态回写委托给同一个锁作用域，
    // 确保 provider 创建成功后，externalSandboxId 与本次创建结果原子地落回数据库。
    logger.info(
      `[reconcile] sandboxId='${instance.id}' instanceStatus='${instance.status}' machineId='${instance.machineId}' externalSandboxId='${instance.externalSandboxId ?? ""}'`,
    );
    if (instance.status === "deleting") throw new SandboxStateError(`sandbox instance '${instance.id}' is deleting`);
    if (["starting", "creating"].includes(instance.status)) return instance;
    if (instance.status === "ready" && (await this.isMachineOnline(instance.machineId))) return instance;
    if (instance.status === "error" && !instance.externalSandboxId) return this.createRemote(instance, repository);

    try {
      const provider = this.dependencies.providers.get(instance.providerKey);
      const ref = instance.externalSandboxId ? await provider.get(instance.externalSandboxId, instance.id) : null;
      logger.info(
        `[reconcile] provider result sandboxId='${instance.id}' providerSandboxId='${instance.externalSandboxId ?? ""}' providerStatus='${ref?.status ?? "missing"}'`,
      );
      if (!ref) {
        logger.warn(`[reconcile] provider resource missing, creating sandboxId='${instance.id}'`);
        return this.createRemote(instance, repository);
      }
      if (ref.status === "stopped") {
        logger.info(`[reconcile] provider resource stopped, resuming sandboxId='${instance.id}'`);
        return this.resumeRemote(instance, provider, ref, repository);
      }
      if (ref.status === "error") {
        logger.warn(`[reconcile] provider resource errored, recreating sandboxId='${instance.id}'`);
        return this.recreateRemote(instance, repository);
      }
      logger.info(`[reconcile] provider resource is '${ref.status}', waiting for ACP sandboxId='${instance.id}'`);
      return this.saveProviderRef(instance.id, ref, repository);
    } catch (error) {
      await repository.update(instance.id, "error", {
        providerPayload: error instanceof Error ? { message: error.message } : error,
      });
      throw error;
    }
  }

  private async createRemote(
    instance: SandboxInstance,
    repository: Pick<SandboxInstanceLockScope, "update"> = this.instances,
  ): Promise<SandboxInstance> {
    // 该方法只能在已完成并发协调后执行。provider.create 是外部副作用，
    // 调用前不能释放 sandbox_instance 行锁，否则下一个请求会重复创建资源。
    try {
      const resolvedConfig = this.readResolvedConfig(instance.resolvedConfig);
      const request: SandboxCreateInput = {
        sandboxId: instance.id,
        poolId: instance.sandboxPoolId,
        template: { type: "image", value: resolvedConfig.image },
        resources: resolvedConfig.resources,
        providerExtra: resolvedConfig.providerExtra,
      };
      const provider = this.dependencies.providers.get(instance.providerKey);
      const ref = await provider.create(request);
      if (ref.status === "stopped") return this.resumeRemote(instance, provider, ref, repository);
      return this.saveProviderRef(instance.id, ref, repository);
    } catch (error) {
      await repository.update(instance.id, "error", {
        providerPayload: error instanceof Error ? { message: error.message } : error,
      });
      throw error;
    }
  }

  private async recreateRemote(
    instance: SandboxInstance,
    repository: Pick<SandboxInstanceLockScope, "update"> = this.instances,
  ): Promise<SandboxInstance> {
    try {
      if (instance.externalSandboxId) {
        logger.warn(
          `[recreate] destroying provider resource sandboxId='${instance.id}' providerSandboxId='${instance.externalSandboxId}'`,
        );
        await this.dependencies.providers.get(instance.providerKey).destroy(instance.externalSandboxId, instance.id);
      }
      const reset = await repository.update(instance.id, "creating", {
        externalSandboxId: null,
        providerPayload: null,
      });
      if (!reset) throw new SandboxStateError(`sandbox instance '${instance.id}' not found`);
      logger.info(`[recreate] creating provider resource sandboxId='${instance.id}'`);
      return this.createRemote(reset, repository);
    } catch (error) {
      await repository.update(instance.id, "error", { providerPayload: { reason: "sandbox_recreate_failed", error } });
      throw error;
    }
  }

  private async resumeRemote(
    instance: SandboxInstance,
    provider: SandboxProvider,
    ref: SandboxRef,
    repository: Pick<SandboxInstanceLockScope, "update"> = this.instances,
  ) {
    const resumed = await provider.resume(ref.sandboxId, instance.id);
    return this.saveProviderRef(instance.id, resumed, repository);
  }

  private async destroyProviderResource(instance: SandboxInstance): Promise<void> {
    if (instance.externalSandboxId) {
      await this.dependencies.providers.get(instance.providerKey).destroy(instance.externalSandboxId, instance.id);
    }
    unregisterRemoteNode(instance.machineId);
    stopHeartbeat(instance.machineId);
  }

  private readResolvedConfig(value: unknown): SandboxResolvedConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new SandboxStateError("sandbox instance resolved config is invalid");
    }
    const config = value as { image?: unknown; resources?: unknown; providerExtra?: unknown };
    if (typeof config.image !== "string") throw new SandboxStateError("sandbox instance image snapshot is invalid");
    return {
      image: config.image,
      resources: parseSandboxResources(config.resources),
      providerExtra:
        config.providerExtra && typeof config.providerExtra === "object" && !Array.isArray(config.providerExtra)
          ? (config.providerExtra as Record<string, unknown>)
          : {},
    };
  }

  private async saveProviderRef(
    id: string,
    ref: SandboxRef,
    repository: Pick<SandboxInstanceLockScope, "update"> = this.instances,
  ): Promise<SandboxInstance> {
    const status: SandboxInstanceStatus = ref.status === "error" ? "error" : "starting";
    const instance = await repository.update(id, status, {
      externalSandboxId: ref.sandboxId,
      providerPayload: ref.payload ?? null,
    });
    if (!instance) throw new SandboxStateError(`sandbox instance '${id}' not found`);
    return instance;
  }
}
