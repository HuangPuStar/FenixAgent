import type { AgentInstanceRecord } from "../repositories";

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
}

interface RuntimeEntry {
  generation: number;
  state: RuntimeState;
  operation: RuntimeLifecycleOperation | null;
  operationPromise: Promise<void> | null;
  deleting: boolean;
  lastFailure: string | null;
  abortController: AbortController | null;
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
    this.#handleRuntimeUnavailable(instanceUid, generation, "stopped", "Runtime terminated during lifecycle operation");
  }

  handleRuntimeDisconnect(instanceUid: string, generation: number): void {
    this.#handleRuntimeUnavailable(
      instanceUid,
      generation,
      "unknown",
      "Runtime disconnected during lifecycle operation",
    );
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
          await this.adapter.stop(instanceUid, generation, new AbortController().signal);
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
    state: Extract<RuntimeState, "stopped" | "unknown">,
    reason: string,
  ): void {
    const entry = this.#entries.get(instanceUid);
    if (!entry || entry.generation !== generation) return;
    entry.generation += 1;
    entry.abortController?.abort(new Error(reason));
    entry.state = state;
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
    const controller = new AbortController();
    entry.abortController = controller;

    const promise = this.#execute(instance, operation, mode, generation, controller.signal).finally(() => {
      if (entry.generation !== generation) return;
      entry.operation = null;
      entry.operationPromise = null;
      entry.abortController = null;
      if (operation !== "delete") entry.deleting = false;
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
      if (operation === "restart") {
        entry.state = "stopping";
        await this.adapter.stop(instance.id, generation - 1, signal);
      }
      if (operation === "stop" || operation === "delete") {
        entry.state = "stopping";
        await this.adapter.stop(instance.id, generation - 1, signal);
        if (entry.generation === generation) entry.state = "stopped";
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
      };
      this.#entries.set(instanceUid, entry);
    }
    return entry;
  }
}
