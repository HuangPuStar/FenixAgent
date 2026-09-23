import type { AgentInstanceRecord } from "../repositories/agent-instance";

export type RuntimeStopMode = "strict" | "best-effort";
export type RuntimeLifecycleOperation = "ensure" | "restart" | "stop" | "delete";
export type RuntimeState = "stopped" | "starting" | "running" | "stopping" | "unknown";

export interface RuntimeSnapshot {
  instanceUid: string;
  runtimeGeneration: number;
  state: RuntimeState;
  currentOperation: RuntimeLifecycleOperation | null;
  deleting: boolean;
  lastFailure: string | null;
}

export interface RuntimeAdapter {
  start(instance: AgentInstanceRecord, generation: number, signal: AbortSignal): Promise<void>;
  stop(instanceUid: string, generation: number, signal: AbortSignal): Promise<void>;
  /** 返回编排层或 core 中是否仍存在该 uid 的权威 runtime。 */
  hasActiveRuntime?(instanceUid: string): boolean;
  /** 显式 restart 使用，不按 coordinator 的本地 generation 跳过权威 runtime。 */
  stopActiveRuntime?(instanceUid: string, signal: AbortSignal): Promise<void>;
}

interface RuntimeEntry {
  generation: number;
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
}

export interface RuntimeCoordinatorOptions {
  shutdownDrainTimeoutMs?: number;
}

const DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;
const PRIORITY: Record<RuntimeLifecycleOperation, number> = { ensure: 0, restart: 1, stop: 2, delete: 3 };

/**
 * 进程内 Agent Instance runtime 仲裁器。
 * operation gate 以 uid 隔离；高优先级 intent 会 fencing 旧世代并取消底层共享操作。
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

  stopRuntime(instance: AgentInstanceRecord, mode: RuntimeStopMode, signal?: AbortSignal): Promise<void> {
    return this.#run(instance, "stop", mode, signal);
  }

  deleteRuntime(instance: AgentInstanceRecord, signal?: AbortSignal): Promise<void> {
    return this.#run(instance, "delete", "strict", signal);
  }

  /** DB 删除失败后恢复可操作状态；仅清理由同一次 delete generation 留下且已完成的标记。 */
  recoverDelete(instanceUid: string, generation: number): void {
    const entry = this.#entries.get(instanceUid);
    if (entry && entry.generation === generation && entry.operation === null) entry.deleting = false;
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
      this.#resolveUnknown(entry);
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
    const drains = [...this.#entries.entries()].map(([instanceUid, entry]) => {
      const generation = entry.generation;
      const state = entry.state;
      const operation = entry.operationPromise;
      if (operation) {
        entry.generation += 1;
        entry.abortController?.abort(new Error("Runtime coordinator is shutting down"));
      }

      return (async () => {
        if (operation) {
          await operation.catch(() => undefined);
        } else if (state === "running") {
          const signal = new AbortController().signal;
          if (this.adapter.stopActiveRuntime && this.adapter.hasActiveRuntime?.(instanceUid)) {
            await this.adapter.stopActiveRuntime(instanceUid, signal);
          } else {
            await this.adapter.stop(instanceUid, generation, signal);
          }
        }
        entry.state = "stopped";
      })().catch((error) => {
        entry.lastFailure = error instanceof Error ? error.message : "Runtime shutdown failed";
        entry.state = "unknown";
      });
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
    if (!entry || entry.generation !== generation) return;
    entry.generation += 1;
    entry.abortController?.abort(new Error(reason));
    entry.state = state;
    // 归属只由不可用事件写入:death 传 null 即清空归属;新的不可用事件必须作废任何延后的
    // clean-slate 确认,否则旧确认会在条目之后再次进入 unknown 时被误用为"已确认无残留"。
    entry.machineId = machineId;
    entry.pendingCleanSlate = false;
  }

  /** 把已确认无残留 runtime 的 unknown 复位为 stopped,并推进世代以 fence 掉迟到通知。 */
  #resolveUnknown(entry: RuntimeEntry): void {
    entry.generation += 1;
    entry.state = "stopped";
    entry.machineId = null;
    entry.pendingCleanSlate = false;
    entry.lastFailure = null;
  }

  #run(
    instance: AgentInstanceRecord,
    operation: RuntimeLifecycleOperation,
    mode: RuntimeStopMode,
    waiterSignal?: AbortSignal,
  ): Promise<void> {
    if (this.#shuttingDown) {
      return Promise.reject(new Error("Agent runtime coordinator is shutting down"));
    }
    const entry = this.#entry(instance.id);
    if (entry.deleting && operation !== "delete") {
      return Promise.reject(new Error(`Agent Instance '${instance.id}' is being deleted`));
    }
    if (entry.state === "unknown" && operation !== "stop") {
      return Promise.reject(new Error(`Runtime state for '${instance.id}' is unknown`));
    }
    if (entry.operation && entry.operationPromise) {
      if (entry.operation === operation) return this.#wait(entry.operationPromise, waiterSignal);
      if (PRIORITY[entry.operation] >= PRIORITY[operation]) {
        return this.#wait(entry.operationPromise, waiterSignal).then(() =>
          this.#run(instance, operation, mode, waiterSignal),
        );
      }
      entry.generation += 1;
      entry.abortController?.abort();
    }

    const generation = operation === "ensure" && entry.state === "running" ? entry.generation : entry.generation + 1;
    if (operation === "ensure" && entry.state === "running") return Promise.resolve();
    entry.generation = generation;
    entry.operation = operation;
    entry.deleting = operation === "delete";
    // 任何新 lifecycle intent 接管后,旧断连归属立即失效:否则后续在别的机器上产生的 unknown
    // 会被误判为"本机 clean-slate 已覆盖",放行一次可能与旧进程并存的重启。
    entry.machineId = null;
    entry.pendingCleanSlate = false;
    const controller = new AbortController();
    entry.abortController = controller;

    const promise = this.#execute(instance, operation, mode, generation, controller.signal).finally(() => {
      // 按操作所有权判定:被断连/unavailable 事件 fence 的操作不会更新世代,若沿用世代比对会
      // 永久残留 operation,导致同操作此后只会 #wait 一个已 settle 的 promise(假成功),并使
      // clean-slate 复位条件(operation === null)永不成立。
      if (entry.operationPromise !== promise) return;
      entry.operation = null;
      entry.operationPromise = null;
      entry.abortController = null;
      if (operation !== "delete") entry.deleting = false;
      // 断连导致的 unknown 若已被该机器 clean-slate 确认覆盖,在操作真正释放槽位后补做复位。
      // 进程退出中不参与:那会把 shutdown drain 留下的未确认 runtime 伪装成 stopped。
      if (entry.pendingCleanSlate && entry.state === "unknown" && entry.machineId !== null && !this.#shuttingDown) {
        this.#resolveUnknown(entry);
      }
    });
    entry.operationPromise = promise;
    return this.#wait(promise, waiterSignal);
  }

  async #execute(
    instance: AgentInstanceRecord,
    operation: RuntimeLifecycleOperation,
    mode: RuntimeStopMode,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    const entry = this.#entry(instance.id);
    try {
      if (operation === "restart" && (entry.state !== "stopped" || this.adapter.hasActiveRuntime?.(instance.id))) {
        entry.state = "stopping";
        if (this.adapter.stopActiveRuntime) {
          await this.adapter.stopActiveRuntime(instance.id, signal);
        } else {
          await this.adapter.stop(instance.id, generation - 1, signal);
        }
      }
      if (operation === "stop" || operation === "delete") {
        entry.state = "stopping";
        if (this.adapter.stopActiveRuntime && this.adapter.hasActiveRuntime?.(instance.id)) {
          await this.adapter.stopActiveRuntime(instance.id, signal);
        } else {
          await this.adapter.stop(instance.id, generation - 1, signal);
        }
        if (entry.generation === generation) entry.state = "stopped";
        return;
      }
      if (operation === "ensure" && this.adapter.hasActiveRuntime?.(instance.id)) {
        entry.state = "running";
        entry.lastFailure = null;
        return;
      }
      entry.state = "starting";
      await this.adapter.start(instance, generation, signal);
      if (entry.generation !== generation) {
        await this.adapter.stop(instance.id, generation, new AbortController().signal).catch(() => undefined);
        return;
      }
      entry.state = "running";
      entry.lastFailure = null;
    } catch (error) {
      if (entry.generation === generation) {
        entry.lastFailure = error instanceof Error ? error.message : "Runtime operation failed";
        entry.state =
          operation === "stop" || operation === "delete" || (operation === "restart" && entry.state === "stopping")
            ? "unknown"
            : "stopped";
      }
      if (mode === "strict") throw error;
    }
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
        state: "stopped",
        operation: null,
        operationPromise: null,
        deleting: false,
        lastFailure: null,
        abortController: null,
        machineId: null,
        pendingCleanSlate: false,
      };
      this.#entries.set(instanceUid, entry);
    }
    return entry;
  }
}
