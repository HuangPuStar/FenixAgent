import { createLogger } from "@fenix/logger";
import { stopHeartbeat } from "@fenix/resource-machine/server";
import type { SandboxCreateInput, SandboxProvider, SandboxRef } from "@fenix/sandbox-provider";
import type { SandboxInstance } from "@server/db/schema";
import type { SandboxInstanceLockScope, SandboxInstancePatch } from "../repositories/sandbox-instance-repository";
import { type SandboxInstanceStatus, SandboxStateError } from "./sandbox-errors";
import { readSandboxResolvedConfig } from "./sandbox-instance-snapshot";
import type { SandboxProviderRegistry } from "./sandbox-provider-registry";

const logger = createLogger("sandbox-remote");

/**
 * 远程资源的协调器：把 Instance 记录推进到"有一个可用 Provider 沙盒"的状态。
 *
 * 从 `SandboxManager` 拆出（原文件 ~690 行，超出单文件 500 行上限）。这条边界不是按行数切的：
 * - Manager 负责"业务规则与状态机"（复用、改配置、rebuild、删除、重启恢复标记），
 * - 本类负责"外部副作用 + 并发协调"（provider.create/get/resume/destroy、行锁、machine 路由与心跳的释放）。
 *
 * 两者的失败语义不同：Manager 的失败回写状态并让调用方重试；本类的失败必须在**同一行锁内**回写 error，
 * 否则下一个请求会基于过期的 externalSandboxId 再造一个 Provider 沙盒。
 *
 * 依赖注入点 `releaseRuntime` 由 Machine 资源提供（真实实现经 agent-runtime 的 core runtime 端口注销节点），
 * 测试进程里由宿主绑定到替身注册表；包内用例不能依赖宿主测试设施，因此留出注入点，
 * 让「删除实例必须按 machine_id 释放路由」这条断言仍然打在协调器自己的调用上。
 */

/** 协调器需要的数据访问面：锁内读取/回写，以及未注入锁时的回退路径。 */
export type SandboxRemoteInstanceRepository = {
  findById?(id: string): Promise<SandboxInstance | null>;
  update(id: string, status: string, patch?: SandboxInstancePatch): Promise<SandboxInstance | null>;
  delete?(id: string): Promise<SandboxInstance | null>;
  withLock?: <T>(id: string, operation: (scope: SandboxInstanceLockScope) => Promise<T>) => Promise<T>;
};

export type SandboxRemoteReconcilerDependencies = {
  providers: SandboxProviderRegistry;
  /** 默认 repository：锁内作用域与无锁回退都以它为基准。 */
  instances: SandboxRemoteInstanceRepository;
  /** 判断 Instance 绑定的 Machine 是否已回连；注入点避免用例依赖 machine 资源与 DB。 */
  isMachineOnline: (machineId: string) => Promise<boolean>;
  /** 释放 Machine 的运行时路由；见上方类注释。 */
  releaseRuntime: (machineId: string) => void;
};

export class SandboxRemoteReconciler {
  constructor(private readonly dependencies: SandboxRemoteReconcilerDependencies) {}

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
  async reconcileWithLock(
    instance: SandboxInstance,
    options?: { createMachine?: () => Promise<void> },
  ): Promise<SandboxInstance> {
    const { instances } = this.dependencies;
    if (!instances.withLock) {
      // 仅保留给未注入完整 repository 的单元测试；生产默认 repository 始终提供数据库锁。
      await options?.createMachine?.();
      return options?.createMachine ? this.createRemote(instance) : this.reconcileExisting(instance);
    }
    return instances.withLock(instance.id, async (scope) => {
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

  /** 按 Instance 配置快照重建 Provider 资源；调用方负责保证并发（`recover` 走行锁，`restart` 只读复用）。 */
  async recreateRemote(
    instance: SandboxInstance,
    repository: Pick<SandboxInstanceLockScope, "update"> = this.dependencies.instances,
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

  /** 在原 Provider 资源上恢复连接（资源仍存在，不重建）。 */
  async resumeRemote(
    instance: SandboxInstance,
    provider: SandboxProvider,
    ref: SandboxRef,
    repository: Pick<SandboxInstanceLockScope, "update"> = this.dependencies.instances,
  ): Promise<SandboxInstance> {
    const resumed = await provider.resume(ref.sandboxId, instance.id);
    return this.saveProviderRef(instance.id, resumed, repository);
  }

  /** 回写 Provider 资源标识与状态；`error` 状态必须持久化，否则下一个请求会误判资源健康。 */
  async saveProviderRef(
    id: string,
    ref: SandboxRef,
    repository: Pick<SandboxInstanceLockScope, "update"> = this.dependencies.instances,
  ): Promise<SandboxInstance> {
    const status: SandboxInstanceStatus = ref.status === "error" ? "error" : "starting";
    const instance = await repository.update(id, status, {
      externalSandboxId: ref.sandboxId,
      providerPayload: ref.payload ?? null,
    });
    if (!instance) throw new SandboxStateError(`sandbox instance '${id}' not found`);
    return instance;
  }

  /** 销毁 Provider 资源并释放 Machine 侧连接：路由与心跳都属于该 machine_id，删除后不得再持有。 */
  async destroyProviderResource(instance: SandboxInstance): Promise<void> {
    if (instance.externalSandboxId) {
      await this.dependencies.providers.get(instance.providerKey).destroy(instance.externalSandboxId, instance.id);
    }
    this.dependencies.releaseRuntime(instance.machineId);
    stopHeartbeat(instance.machineId);
  }

  private async reconcileExisting(instance: SandboxInstance): Promise<SandboxInstance> {
    return this.reconcileExistingWithRepository(instance, this.dependencies.instances);
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
    if (instance.status === "ready" && (await this.dependencies.isMachineOnline(instance.machineId))) return instance;
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
    repository: Pick<SandboxInstanceLockScope, "update"> = this.dependencies.instances,
  ): Promise<SandboxInstance> {
    // 该方法只能在已完成并发协调后执行。provider.create 是外部副作用，
    // 调用前不能释放 sandbox_instance 行锁，否则下一个请求会重复创建资源。
    try {
      const resolvedConfig = readSandboxResolvedConfig(instance.resolvedConfig);
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
}
