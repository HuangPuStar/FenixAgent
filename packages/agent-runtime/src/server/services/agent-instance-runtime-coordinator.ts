import { AppError } from "@fenix/platform-sdk";
import type { AgentInstanceRecord } from "../repositories/agent-instance";

export type RuntimeStopMode = "strict" | "best-effort";
export type RuntimeLifecycleOperation = "ensure" | "restart" | "stop" | "delete" | "reclaim";
export type RuntimeState = "stopped" | "starting" | "running" | "stopping" | "unknown";

export interface RuntimeSnapshot {
  instanceUid: string;
  runtimeGeneration: number;
  /** 当前生命周期意图的身份，与实际 runtime 代次独立。 */
  operationId: number;
  state: RuntimeState;
  currentOperation: RuntimeLifecycleOperation | null;
  deleting: boolean;
  lastFailure: string | null;
}

export interface RuntimeAdapter {
  /** 已确认终止后释放依赖该运行实体的执行配额。 */
  onStopped?(instanceUid: string): void;
  start(instance: AgentInstanceRecord, generation: number, signal: AbortSignal): Promise<void>;
  stop(instanceUid: string, generation: number, signal: AbortSignal): Promise<void>;
  /** 返回编排层或 core 中是否仍存在该 uid 的权威 runtime。 */
  hasActiveRuntime?(instanceUid: string): boolean;
  /** 接管已有 runtime 时读取其实际代次，不能用操作编号代替。 */
  getRuntimeGeneration?(instanceUid: string): number | undefined;
  /** 运行成功快照必须匹配真实 Core 身份，Controller 残留不能作为就绪证明。 */
  isRuntimeReady?(instanceUid: string, generation?: number): boolean;
  /** 显式 restart 使用，不按 coordinator 的本地 generation 跳过权威 runtime。 */
  stopActiveRuntime?(instanceUid: string, signal: AbortSignal): Promise<void>;
}

interface RuntimeEntry {
  generation: number;
  operationId: number;
  runtimePresent: boolean;
  state: RuntimeState;
  operation: RuntimeLifecycleOperation | null;
  operationPromise: Promise<void> | null;
  deleting: boolean;
  lastFailure: string | null;
  abortController: AbortController | null;
  /** 该条目当前 unknown 的归属机器;仅由断连事件写入,新 lifecycle intent 接管或复位后清空。 */
  machineId: string | null;
  /** 该机器的 clean-slate 已确认,但条目仍有在飞操作,复位需延后到操作释放槽位之后。 */
  pendingCleanSlate: boolean;
  /** AOS-BUG-002：停止意图独立于运行状态，重连、死亡或 clean-slate 通知不得解除。 */
  manuallyStopped: boolean;
}

export interface RuntimeCoordinatorOptions {
  shutdownDrainTimeoutMs?: number;
}

const DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;
const PRIORITY: Record<RuntimeLifecycleOperation, number> = { ensure: 0, reclaim: 1, restart: 2, stop: 3, delete: 4 };

/**
 * 进程内 Agent Instance runtime 仲裁器。
 * operation gate 以 uid 隔离；操作身份仲裁意图，运行代次关联实际实体。
 */
export class AgentInstanceRuntimeCoordinator {
  readonly #entries = new Map<string, RuntimeEntry>();
  readonly #shutdownDrainTimeoutMs: number;
  #shuttingDown = false;
  #shutdownPromise: Promise<void> | null = null;

  constructor(
    private readonly adapter: RuntimeAdapter,
    options: RuntimeCoordinatorOptions = {},
  ) {
    this.#shutdownDrainTimeoutMs = options.shutdownDrainTimeoutMs ?? DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS;
  }

  snapshot(instanceUid: string): RuntimeSnapshot {
    const entry = this.#entry(instanceUid);
    return {
      instanceUid,
      runtimeGeneration: entry.generation,
      operationId: entry.operationId,
      state: entry.state,
      currentOperation: entry.operation,
      deleting: entry.deleting,
      lastFailure: entry.lastFailure,
    };
  }

  ensureRuntime(instance: AgentInstanceRecord, signal?: AbortSignal): Promise<void> {
    return this.#run(instance, "ensure", "strict", signal);
  }

  restartRuntime(instance: AgentInstanceRecord, signal?: AbortSignal): Promise<void> {
    return this.#run(instance, "restart", "strict", signal);
  }

  stopRuntime(instance: Pick<AgentInstanceRecord, "id">, mode: RuntimeStopMode, signal?: AbortSignal): Promise<void> {
    const stopping = this.#run(instance, "stop", "strict", signal);
    // 宽松调用者只能放宽自身返回值，不能把共享停止操作的失败变成其他调用者的成功。
    return mode === "strict" ? stopping : stopping.catch(() => undefined);
  }

  /** 自动回收只改变运行事实，不建立用户手动停止意图。 */
  reclaimRuntime(
    instance: Pick<AgentInstanceRecord, "id">,
    generation?: number,
    canReclaim?: () => boolean,
  ): Promise<void> {
    const entry = this.#entry(instance.id);
    if (generation !== undefined && entry.generation > generation) return Promise.resolve();
    if (generation !== undefined && entry.runtimePresent && entry.generation !== generation) return Promise.resolve();
    if (generation !== undefined && !entry.runtimePresent) entry.generation = Math.max(entry.generation, generation);
    return this.#run(instance, "reclaim", "strict", undefined, generation, canReclaim);
  }

  deleteRuntime(instance: AgentInstanceRecord, signal?: AbortSignal): Promise<void> {
    return this.#run(instance, "delete", "strict", signal);
  }

  /** DB 删除失败后恢复可操作状态；仅释放同一次 delete 操作留下且已完成的标记。 */
  recoverDelete(instanceUid: string, operationId: number): void {
    const entry = this.#entries.get(instanceUid);
    if (entry && entry.operationId === operationId && entry.operation === null) entry.deleting = false;
  }

  handleRuntimeDeath(instanceUid: string, generation: number): void {
    this.#handleRuntimeUnavailable(
      instanceUid,
      generation,
      null,
      "stopped",
      "Runtime terminated during lifecycle operation",
    );
  }

  handleRuntimeDisconnect(instanceUid: string, generation: number, machineId: string): void {
    this.#handleRuntimeUnavailable(
      instanceUid,
      generation,
      machineId,
      "unknown",
      "Runtime disconnected during lifecycle operation",
    );
  }

  /**
   * 机器确认 clean slate(其旧 runtime 已全部终止)后,解除该机器断连造成的 unknown。
   * 只复位「归属该机器 + unknown + 无在飞操作」的条目;条目仍被操作独占时置延后标记,
   * 待操作释放槽位后再复位。其他来源的 unknown(操作失败、shutdown 排空)不参与。
   */
  handleMachineCleanSlate(machineId: string): string[] {
    if (this.#shuttingDown) return [];
    const resolved: string[] = [];
    for (const [instanceUid, entry] of this.#entries) {
      if (entry.machineId !== machineId || entry.state !== "unknown") continue;
      if (entry.operation !== null) {
        entry.pendingCleanSlate = true;
        continue;
      }
      this.#resolveUnknown(instanceUid, entry);
      resolved.push(instanceUid);
    }
    return resolved;
  }

  shutdown(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    this.#shuttingDown = true;
    this.#shutdownPromise = this.#drainForShutdown();
    return this.#shutdownPromise;
  }

  async #drainForShutdown(): Promise<void> {
    const drains = [...this.#entries.entries()].map(async ([instanceUid, entry]) => {
      const operation = entry.operationPromise;
      entry.operationId += 1;
      entry.abortController?.abort(new Error("Runtime coordinator is shutting down"));
      try {
        // 被取消的启动会先补偿自身；确认结束后再处理仍存在的运行实体。
        if (operation) await operation.catch(() => undefined);
        if (entry.runtimePresent || this.adapter.hasActiveRuntime?.(instanceUid)) {
          await this.#stopCurrent(instanceUid, entry, new AbortController().signal);
        }
        entry.state = "stopped";
      } catch (error) {
        entry.lastFailure = error instanceof Error ? error.message : "Runtime shutdown failed";
        entry.state = "unknown";
      }
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      Promise.all(drains).then(() => false),
      new Promise<true>((resolve) => {
        timer = setTimeout(() => resolve(true), this.#shutdownDrainTimeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (timedOut) {
      for (const entry of this.#entries.values()) {
        if (entry.state !== "stopped") entry.state = "unknown";
      }
    }
  }

  #handleRuntimeUnavailable(
    instanceUid: string,
    generation: number,
    machineId: string | null,
    state: Extract<RuntimeState, "stopped" | "unknown">,
    reason: string,
  ): void {
    const entry = this.#entries.get(instanceUid);
    if (!entry?.runtimePresent || entry.generation !== generation) return;
    entry.operationId += 1;
    entry.runtimePresent = false;
    entry.abortController?.abort(new Error(reason));
    entry.state = state;
    if (state === "stopped") this.adapter.onStopped?.(instanceUid);
    // 归属只由不可用事件写入:death 传 null 即清空归属;新的不可用事件必须作废任何延后的
    // clean-slate 确认,否则旧确认会在条目之后再次进入 unknown 时被误用为"已确认无残留"。
    entry.machineId = machineId;
    entry.pendingCleanSlate = false;
  }

  /** 已确认无残留 runtime 时解除 unknown；实体已不存在，旧通知不再有提交权。 */
  #resolveUnknown(instanceUid: string, entry: RuntimeEntry): void {
    entry.operationId += 1;
    entry.runtimePresent = false;
    entry.state = "stopped";
    entry.machineId = null;
    entry.pendingCleanSlate = false;
    entry.lastFailure = null;
    this.adapter.onStopped?.(instanceUid);
  }

  #run(
    instance: AgentInstanceRecord | Pick<AgentInstanceRecord, "id">,
    operation: RuntimeLifecycleOperation,
    mode: RuntimeStopMode,
    waiterSignal?: AbortSignal,
    expectedGeneration?: number,
    canReclaim?: () => boolean,
  ): Promise<void> {
    if (this.#shuttingDown) return Promise.reject(new Error("Agent runtime coordinator is shutting down"));
    const entry = this.#entry(instance.id);
    if (expectedGeneration !== undefined && entry.generation !== expectedGeneration) return Promise.resolve();
    if (entry.deleting && operation !== "delete") {
      return Promise.reject(new Error(`Agent Instance '${instance.id}' is being deleted`));
    }
    if (entry.state === "unknown" && operation === "ensure") {
      return Promise.reject(new Error(`Runtime state for '${instance.id}' is unknown`));
    }
    if (operation === "ensure" && entry.manuallyStopped) {
      return Promise.reject(new AppError("Agent Instance is stopped; restart it explicitly", "INSTANCE_STOPPED", 409));
    }
    if (operation === "stop") entry.manuallyStopped = true;
    let previous: Promise<void> | null = null;
    if (entry.operation && entry.operationPromise) {
      if (entry.operation === operation) return this.#wait(entry.operationPromise, waiterSignal);
      if (PRIORITY[entry.operation] >= PRIORITY[operation]) {
        return this.#wait(entry.operationPromise, waiterSignal).then(() =>
          this.#run(instance, operation, mode, waiterSignal, expectedGeneration, canReclaim),
        );
      }
      previous = entry.operationPromise;
      entry.abortController?.abort(new Error(`Runtime operation superseded by ${operation}`));
    }
    if (operation === "ensure" && entry.state === "running") {
      const ready = this.adapter.isRuntimeReady
        ? this.adapter.isRuntimeReady(instance.id, entry.generation)
        : !this.adapter.hasActiveRuntime || this.adapter.hasActiveRuntime(instance.id);
      if (ready) return Promise.resolve();
      entry.runtimePresent = false;
      entry.state = "stopped";
    }
    if (entry.state === "unknown" && !entry.runtimePresent) {
      entry.machineId = null;
      entry.pendingCleanSlate = false;
    }
    const operationId = ++entry.operationId;
    entry.operation = operation;
    entry.deleting = operation === "delete";
    const controller = new AbortController();
    entry.abortController = controller;
    const promise = this.#execute(
      instance,
      operation,
      mode,
      operationId,
      controller.signal,
      previous,
      canReclaim,
    ).finally(() => {
      if (entry.operationPromise !== promise) return;
      entry.operation = null;
      entry.operationPromise = null;
      entry.abortController = null;
      // 只有 runtime 已确认停止的 delete 才继续持有 DB 删除门禁。
      if (operation !== "delete" || entry.state !== "stopped") entry.deleting = false;
      if (entry.pendingCleanSlate && entry.state === "unknown" && entry.machineId !== null && !this.#shuttingDown) {
        this.#resolveUnknown(instance.id, entry);
      }
    });
    entry.operationPromise = promise;
    return this.#wait(promise, waiterSignal);
  }

  async #execute(
    instance: AgentInstanceRecord | Pick<AgentInstanceRecord, "id">,
    operation: RuntimeLifecycleOperation,
    mode: RuntimeStopMode,
    operationId: number,
    signal: AbortSignal,
    previous: Promise<void> | null,
    canReclaim?: () => boolean,
  ): Promise<void> {
    const entry = this.#entry(instance.id);
    let startingGeneration: number | undefined;
    // 等待旧操作期间可能已有新执行绑定；自动回收必须在实际停止前再次确认占用。
    if (previous) await previous.catch(() => undefined);
    if (operation === "reclaim" && canReclaim && !canReclaim()) return;
    try {
      signal.throwIfAborted();
      if (entry.operationId !== operationId) throw new Error("Runtime operation was superseded");
      if (operation !== "ensure") {
        entry.state = "stopping";
        await this.#stopCurrent(instance.id, entry, signal);
        signal.throwIfAborted();
        if (entry.operationId !== operationId) throw new Error("Runtime stop confirmation was superseded");
        entry.state = "stopped";
        entry.lastFailure = null;
        if (operation !== "restart") return;
      }
      if (operation === "ensure" && this.adapter.hasActiveRuntime?.(instance.id)) {
        if (!this.adapter.isRuntimeReady || this.adapter.isRuntimeReady(instance.id)) {
          entry.generation = this.adapter.getRuntimeGeneration?.(instance.id) ?? entry.generation;
          entry.runtimePresent = true;
          entry.state = "running";
          entry.lastFailure = null;
          return;
        }
        entry.state = "stopping";
        await this.#stopCurrent(instance.id, entry, signal);
        signal.throwIfAborted();
        if (entry.operationId !== operationId) throw new Error("Runtime reconciliation was superseded");
      }
      entry.machineId = null;
      entry.pendingCleanSlate = false;
      startingGeneration = ++entry.generation;
      entry.runtimePresent = true;
      entry.state = "starting";
      if (!("environmentId" in instance)) throw new Error("Runtime start requires a persistent instance record");
      await this.adapter.start(instance, startingGeneration, signal);
      signal.throwIfAborted();
      if (entry.operationId !== operationId) throw new Error("Runtime start confirmation was superseded");
      entry.state = "running";
      if (operation === "restart") entry.manuallyStopped = false;
      entry.lastFailure = null;
    } catch (error) {
      let failure = error;
      if (startingGeneration !== undefined) {
        try {
          await this.adapter.stop(instance.id, startingGeneration, new AbortController().signal);
          if (entry.generation === startingGeneration) {
            entry.runtimePresent = false;
            this.adapter.onStopped?.(instance.id);
          }
        } catch (cleanupError) {
          const cleanupFailure = new AggregateError(
            [error, cleanupError],
            "Runtime start cleanup could not be confirmed",
          );
          failure = cleanupFailure;
          entry.lastFailure = cleanupFailure.message;
          entry.state = "unknown";
        }
      }
      if (entry.operationId === operationId) {
        entry.lastFailure = failure instanceof Error ? failure.message : "Runtime operation failed";
        entry.state = startingGeneration !== undefined && !entry.runtimePresent ? "stopped" : "unknown";
      }
      // 死亡/clean-slate 事件已给出更强事实，不能被取消操作的结束状态覆盖。
      if (mode === "strict") throw failure;
    }
  }

  async #stopCurrent(instanceUid: string, entry: RuntimeEntry, signal: AbortSignal): Promise<void> {
    if (this.adapter.stopActiveRuntime && this.adapter.hasActiveRuntime?.(instanceUid)) {
      await this.adapter.stopActiveRuntime(instanceUid, signal);
    } else {
      await this.adapter.stop(instanceUid, entry.generation, signal);
    }
    entry.runtimePresent = false;
    this.adapter.onStopped?.(instanceUid);
  }

  #wait(operation: Promise<void>, signal?: AbortSignal): Promise<void> {
    if (!signal) return operation;
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }

  #entry(instanceUid: string): RuntimeEntry {
    let entry = this.#entries.get(instanceUid);
    if (!entry) {
      entry = {
        generation: 0,
        operationId: 0,
        runtimePresent: false,
        state: "stopped",
        operation: null,
        operationPromise: null,
        deleting: false,
        lastFailure: null,
        abortController: null,
        machineId: null,
        pendingCleanSlate: false,
        manuallyStopped: false,
      };
      this.#entries.set(instanceUid, entry);
    }
    return entry;
  }
}
