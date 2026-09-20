import { createLogger } from "@fenix/logger";
import { createSandboxMachine, isMachineOnline, releaseMachineRuntime } from "@fenix/resource-machine/server";
import type { SandboxResourceOverrides, SandboxResources, SandboxTemplate } from "@fenix/sandbox-provider";
import type { SandboxInstance, SandboxPool } from "@server/db/schema";
import type { SandboxInstanceLockScope } from "../repositories/sandbox-instance-repository";
import {
  createSandboxInstance,
  deleteSandboxInstance,
  findActiveSandboxInstance,
  findSandboxInstanceById,
  findSandboxInstanceByIdForUser,
  listSandboxInstances,
  updateSandboxInstance,
  withSandboxInstanceLock,
} from "../repositories/sandbox-instance-repository";
import { findReadableSandboxPoolById, findSandboxPoolById } from "../repositories/sandbox-pool-repository";
import { getProviderExtra, getSandboxAgentType, resolveSandboxConfig, sandboxConfigsEqual } from "./sandbox-config";
import { SandboxInstanceConflictError, SandboxStateError } from "./sandbox-errors";
import { asSandboxResources, sandboxMachineId, withMachineId } from "./sandbox-instance-snapshot";
import type { SandboxProviderRegistry } from "./sandbox-provider-registry";
import { SandboxRemoteReconciler } from "./sandbox-remote-reconciler";

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
  /** 由 Machine 资源提供的身份创建能力；注入点避免 Manager 测试依赖数据库。 */
  createMachine?: typeof createSandboxMachine;
  /**
   * 由 Machine 资源提供的运行时路由释放能力。
   *
   * 见 `SandboxRemoteReconciler`：删除实例必须注销该 machine 的路由，测试进程里真实实现依赖宿主
   * 绑定的替身注册表，因此留出注入点，让断言仍打在 Sandbox 自己的调用上。
   */
  releaseRuntime?: (machineId: string) => void;
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

export class SandboxManager {
  private readonly pools: SandboxPoolRepository;
  private readonly instances: SandboxInstanceRepository;
  private readonly now: () => Date;
  private readonly createMachine: typeof createSandboxMachine;
  /** `restart` 需要直接查询 Provider 资源是否仍可复用，因此这里保留注册表句柄。 */
  private readonly providers: SandboxProviderRegistry;
  /** 远程资源（Provider 沙盒、machine 路由）的创建与释放都收敛在协调器内。 */
  private readonly remote: SandboxRemoteReconciler;

  constructor(dependencies: SandboxManagerDependencies) {
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
    this.createMachine = dependencies.createMachine ?? createSandboxMachine;
    this.providers = dependencies.providers;
    this.remote = new SandboxRemoteReconciler({
      providers: this.providers,
      instances: this.instances,
      isMachineOnline: dependencies.isMachineOnline ?? isMachineOnline,
      releaseRuntime: dependencies.releaseRuntime ?? releaseMachineRuntime,
    });
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
    if (existing) return this.remote.reconcileWithLock(existing);

    const createdAt = this.now();
    const machineId = sandboxMachineId(input.sandboxId);
    const baseResolvedConfig = resolveSandboxConfig(
      pool.image ?? input.template.value,
      asSandboxResources(pool.defaultResources),
      input.resourceOverrides,
      getProviderExtra(pool.extra, input.providerKey),
      input.userId,
    );
    const resolvedConfig = withMachineId(baseResolvedConfig, machineId);

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
        if (concurrent) return this.remote.reconcileWithLock(concurrent);
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
    return this.remote.reconcileWithLock(instance, {
      createMachine: async () => {
        await this.createMachine({
          id: machineId,
          organizationId: null,
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

    const provider = this.providers.get(instance.providerKey);
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
      return this.remote.resumeRemote(instance, provider, ref);
    }

    // creating/ready 资源仍然有效，只需重新等待其 ACP runtime 回连。
    return this.remote.saveProviderRef(instance.id, ref);
  }

  /** ACP 等待多次失败且原 Provider 资源无法恢复时，按 Instance 配置快照重建。 */
  async recover(sandboxId: string): Promise<SandboxInstance> {
    const recoverLocked = async (scope: SandboxInstanceLockScope): Promise<SandboxInstance> => {
      const instance = await scope.findById(sandboxId);
      if (!instance) throw new SandboxStateError(`sandbox instance '${sandboxId}' not found`);
      logger.warn(
        `[recover] ACP connection timeout, recreating provider resource sandboxId='${instance.id}' status='${instance.status}' externalSandboxId='${instance.externalSandboxId ?? ""}'`,
      );
      return this.remote.recreateRemote(instance, scope);
    };

    if (this.instances.withLock) return this.instances.withLock(sandboxId, recoverLocked);
    const instance = await this.instances.findById?.(sandboxId);
    if (!instance) throw new SandboxStateError(`sandbox instance '${sandboxId}' not found`);
    logger.warn(
      `[recover] ACP connection timeout, recreating provider resource sandboxId='${instance.id}' status='${instance.status}' externalSandboxId='${instance.externalSandboxId ?? ""}'`,
    );
    return this.remote.recreateRemote(instance);
  }

  async getForUser(id: string, userId: string): Promise<SandboxInstance | null> {
    return this.instances.findByIdForUser(id, userId);
  }

  /** 主动销毁 Provider 资源、移除 Machine 连接路由并删除 Instance 记录。 */
  async deleteForUser(id: string, userId: string): Promise<void> {
    const deleteLocked = async (scope: SandboxInstanceLockScope): Promise<void> => {
      const instance = await scope.findById(id);
      if (!instance || instance.userId !== userId) return;

      await scope.update(id, "deleting", { providerPayload: { reason: "sandbox_delete_requested" } });
      try {
        await this.remote.destroyProviderResource(instance);
        await scope.delete(id);
      } catch (error) {
        await scope.update(id, "error", {
          providerPayload: {
            reason: "sandbox_delete_failed",
            message: error instanceof Error ? error.message : String(error),
          },
        });
        throw error;
      }
    };

    if (this.instances.withLock) {
      try {
        await this.instances.withLock(id, deleteLocked);
      } catch (error) {
        if (error instanceof Error && error.message === `sandbox instance '${id}' not found`) return;
        throw error;
      }
      return;
    }

    const instance = await this.instances.findByIdForUser(id, userId);
    if (!instance) return;
    if (!this.instances.delete) throw new SandboxStateError("sandbox instance delete is not configured");
    try {
      await this.remote.destroyProviderResource(instance);
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
    const nextConfig = withMachineId(
      resolveSandboxConfig(
        pool.image,
        asSandboxResources(pool.defaultResources),
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
      await this.remote.destroyProviderResource(instance);
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
      const nextConfig = withMachineId(
        resolveSandboxConfig(
          pool.image,
          asSandboxResources(pool.defaultResources),
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
        await this.remote.destroyProviderResource(instance);
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
}
