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
import {
  createSandboxInstance,
  deleteSandboxInstance,
  findActiveSandboxInstance,
  findSandboxInstanceById,
  findSandboxInstanceByIdForUser,
  listSandboxInstances,
  updateSandboxInstance,
} from "../../repositories/sandbox-instance-repository";
import { findReadableSandboxPoolById, findSandboxPoolById } from "../../repositories/sandbox-pool-repository";
import { unregisterRemoteNode } from "../core-bootstrap";
import { createSandboxMachine, deleteSandboxMachine } from "../registry";
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
    if (existing) return this.reconcileExisting(existing);

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

    await createSandboxMachine({
      id: machineId,
      organizationId: input.organizationId ?? null,
      userId: input.userId,
      agentName: input.agentName ?? getSandboxAgentType(pool.extra),
    });

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
      // machine 行已先插入；无论何种失败（唯一索引冲突 / FK 缺失 / DB 错误），
      // 本请求都未成功创建 sandbox_instance，machine 行已成孤儿，必须补偿删除
      //（否则每次失败残留一条无主 mach_sandbox_* 记录，永不清扫）。
      // 补偿删除为尽力而为：失败仅记日志，不覆盖原始错误（排障需保留真实原因）。
      await deleteSandboxMachine(machineId).catch((cleanupError: unknown) => {
        logger.error(
          `[sandbox] failed to compensate machine '${machineId}' after create failure: ` +
            (cleanupError instanceof Error ? cleanupError.message : String(cleanupError)),
        );
      });
      if (isUniqueConstraintError(error)) {
        // 并发创建冲突（同一 provider+pool+userId 同时首启）：复用并发方的实例。
        // 注意并发方的 sandboxId/machineId 与本请求不同，本请求的 machine 行已在上方
        // 补偿删除，复用不产生双记录。
        const concurrent = await this.instances.findActive(input.providerKey, input.poolId, input.userId);
        if (concurrent) return this.reconcileExisting(concurrent);
        // 冲突但查不到并发实例（极端竞态）：按冲突上报
        throw new SandboxInstanceConflictError(
          error instanceof Error ? error.message : "sandbox instance create conflicted",
        );
      }
      // 非唯一索引冲突的失败（FK 缺失、DB 连接错误等）保留原始错误：
      // 原实现一律包 SandboxInstanceConflictError 会把 DB 故障误报为"冲突"、误导排障
      throw error instanceof Error ? error : new Error(String(error));
    }

    return this.createRemote(instance);
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
  async updateInstanceConfig(id: string, resourceOverrides: SandboxResourceOverrides | null): Promise<SandboxInstance> {
    const instance = await this.instances.findById?.(id);
    if (!instance) throw new SandboxStateError(`sandbox instance '${id}' not found`);
    const pool = await this.getPool(instance.sandboxPoolId);
    const nextConfig = addMachineIdToConfig(
      resolveSandboxConfig(
        pool.image,
        asResources(pool.defaultResources),
        resourceOverrides,
        getProviderExtra(pool.extra, instance.providerKey),
        instance.userId,
      ),
      instance.machineId,
    );
    const changed = !sandboxConfigsEqual(instance.resolvedConfig, nextConfig);
    if (!changed) {
      const updated = await this.instances.update(id, instance.status, {
        resourceOverrides,
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
        resourceOverrides,
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
    logger.info(
      `[reconcile] sandboxId='${instance.id}' instanceStatus='${instance.status}' machineId='${instance.machineId}' externalSandboxId='${instance.externalSandboxId ?? ""}'`,
    );
    if (instance.status === "deleting") throw new SandboxStateError(`sandbox instance '${instance.id}' is deleting`);
    if (["starting", "creating"].includes(instance.status)) return instance;
    if (instance.status === "ready" && (await this.isMachineOnline(instance.machineId))) return instance;
    if (instance.status === "error" && !instance.externalSandboxId) return this.createRemote(instance);

    try {
      const provider = this.dependencies.providers.get(instance.providerKey);
      const ref = instance.externalSandboxId ? await provider.get(instance.externalSandboxId, instance.id) : null;
      logger.info(
        `[reconcile] provider result sandboxId='${instance.id}' providerSandboxId='${instance.externalSandboxId ?? ""}' providerStatus='${ref?.status ?? "missing"}'`,
      );
      if (!ref) {
        logger.warn(`[reconcile] provider resource missing, creating sandboxId='${instance.id}'`);
        return this.createRemote(instance);
      }
      if (ref.status === "stopped") {
        logger.info(`[reconcile] provider resource stopped, resuming sandboxId='${instance.id}'`);
        return this.resumeRemote(instance, provider, ref);
      }
      if (ref.status === "error") {
        logger.warn(`[reconcile] provider resource errored, recreating sandboxId='${instance.id}'`);
        return this.recreateRemote(instance);
      }
      logger.info(`[reconcile] provider resource is '${ref.status}', waiting for ACP sandboxId='${instance.id}'`);
      return this.saveProviderRef(instance.id, ref);
    } catch (error) {
      await this.markError(instance.id, error instanceof Error ? { message: error.message } : error);
      throw error;
    }
  }

  private async createRemote(instance: SandboxInstance): Promise<SandboxInstance> {
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
      if (ref.status === "stopped") return this.resumeRemote(instance, provider, ref);
      return this.saveProviderRef(instance.id, ref);
    } catch (error) {
      await this.markError(instance.id, error instanceof Error ? { message: error.message } : error);
      throw error;
    }
  }

  private async recreateRemote(instance: SandboxInstance): Promise<SandboxInstance> {
    try {
      if (instance.externalSandboxId) {
        logger.warn(
          `[recreate] destroying provider resource sandboxId='${instance.id}' providerSandboxId='${instance.externalSandboxId}'`,
        );
        await this.dependencies.providers.get(instance.providerKey).destroy(instance.externalSandboxId, instance.id);
      }
      const reset = await this.instances.update(instance.id, "creating", {
        externalSandboxId: null,
        providerPayload: null,
      });
      if (!reset) throw new SandboxStateError(`sandbox instance '${instance.id}' not found`);
      logger.info(`[recreate] creating provider resource sandboxId='${instance.id}'`);
      return this.createRemote(reset);
    } catch (error) {
      await this.markError(instance.id, { reason: "sandbox_recreate_failed", error });
      throw error;
    }
  }

  private async resumeRemote(instance: SandboxInstance, provider: SandboxProvider, ref: SandboxRef) {
    const resumed = await provider.resume(ref.sandboxId, instance.id);
    return this.saveProviderRef(instance.id, resumed);
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

  private async saveProviderRef(id: string, ref: SandboxRef): Promise<SandboxInstance> {
    const status: SandboxInstanceStatus = ref.status === "error" ? "error" : "starting";
    const instance = await this.instances.update(id, status, {
      externalSandboxId: ref.sandboxId,
      providerPayload: ref.payload ?? null,
    });
    if (!instance) throw new SandboxStateError(`sandbox instance '${id}' not found`);
    return instance;
  }
}
