import { createLogger } from "@fenix/logger";
import {
  isMachineRuntimeReady,
  MachineConnectionTimeoutError,
  type MachineStatusReader,
  waitForMachineConnection,
} from "@fenix/resource-machine/server";
import type { SandboxInstance } from "@fenix/resource-sandbox/db";
import { getSandboxConfig } from "../config";
import { SandboxRuntimeNotReadyError, SandboxStateError } from "./sandbox-errors";
import type { SandboxManager, SandboxManagerCreateInput } from "./sandbox-manager";

const logger = createLogger("sandbox-execution");

/** 已完成 ACP 激活的沙盒执行节点。 */
export type PreparedExecutionNode = { nodeId: string; source: "sandbox"; sandboxId: string };

/** 按资源池准备执行节点的输入。 */
export type SandboxExecutionInput = Omit<SandboxManagerCreateInput, "poolId" | "providerKey" | "template"> & {
  sandboxPoolId: string;
  organizationId?: string;
  runtimeConnectTimeoutMs?: number;
};

/** 仅恢复属主已有的 Machine，不负责创建或切换持久 Instance。 */
export type DisconnectedSandboxRecoveryInput = {
  machineId: string;
  ownerUserId: string;
  isCurrent(): boolean;
  signal?: AbortSignal;
  runtimeConnectTimeoutMs?: number;
};

type RecoveryRound = { promise: Promise<void>; requesters: Set<() => boolean> };

/** 创建或复用 Sandbox，合并同一沙盒的恢复并等待 ACP 真正就绪。 */
export class SandboxExecutionHandler {
  private readonly rounds = new Map<string, RecoveryRound>();

  constructor(
    private readonly manager: SandboxManager,
    private readonly readMachineReady: MachineStatusReader = isMachineRuntimeReady,
  ) {}

  /** 正常进入沿用资源池解析与创建规则，再与断连恢复共享连接等待。 */
  async prepare(input: SandboxExecutionInput): Promise<PreparedExecutionNode> {
    const pool = await this.manager.getPool(input.sandboxPoolId, input.organizationId);
    let priorAction: "resume" | "replace" | undefined;
    const instance = await this.manager.createOrReuse(
      {
        ...input,
        poolId: pool.id,
        providerKey: pool.providerKey,
        template: { type: "image", value: pool.image },
        organizationId: input.organizationId,
      },
      (action) => {
        priorAction = action;
      },
    );
    await this.joinRecovery(instance, input.runtimeConnectTimeoutMs, true, () => true, undefined, priorAction);
    return { nodeId: instance.machineId, source: "sandbox", sandboxId: instance.id };
  }

  /** 断连 unknown 的进入前置步骤；普通机器或归属不匹配时保持原生命周期门禁。 */
  async recoverDisconnectedMachine(input: DisconnectedSandboxRecoveryInput): Promise<void> {
    input.signal?.throwIfAborted();
    const instance = await this.manager.getByMachineForUser(input.machineId, input.ownerUserId);
    if (!instance || !input.isCurrent()) return;
    await this.joinRecovery(
      instance,
      input.runtimeConnectTimeoutMs,
      false,
      () => !input.signal?.aborted && input.isCurrent(),
      input.signal,
    );
  }

  private async joinRecovery(
    instance: SandboxInstance,
    timeoutMs: number | undefined,
    waitFirst: boolean,
    isCurrent: () => boolean,
    signal?: AbortSignal,
    priorAction?: "resume" | "replace",
  ): Promise<void> {
    signal?.throwIfAborted();
    let round = this.rounds.get(instance.id);
    if (!round) {
      const requesters = new Set<() => boolean>();
      const promise = Promise.resolve()
        .then(() =>
          this.recoverConnection(
            instance,
            timeoutMs ?? getSandboxConfig().sandboxRuntimeConnectTimeoutMs,
            waitFirst,
            () => [...requesters].some((check) => check()),
            priorAction,
          ),
        )
        .finally(() => {
          this.rounds.delete(instance.id);
        });
      round = { promise, requesters };
      this.rounds.set(instance.id, round);
    }
    round.requesters.add(isCurrent);
    try {
      await waitForRecovery(round.promise, signal);
    } finally {
      round.requesters.delete(isCurrent);
    }
  }

  private async recoverConnection(
    instance: SandboxInstance,
    timeoutMs: number,
    waitFirst: boolean,
    isCurrent: () => boolean,
    priorAction?: "resume" | "replace",
  ): Promise<void> {
    const startedAt = Date.now();
    const wait = async () => {
      try {
        await waitForMachineConnection(instance.machineId, timeoutMs, this.readMachineReady);
        return true;
      } catch (error) {
        if (!(error instanceof MachineConnectionTimeoutError)) throw error;
        return false;
      }
    };
    const fail = async (expected: SandboxInstance): Promise<never> => {
      await this.manager.markRuntimeNotReady(expected);
      logger.error("Sandbox ACP recovery timed out", { sandboxId: instance.id, machineId: instance.machineId });
      throw new SandboxRuntimeNotReadyError(instance.id);
    };
    logger.info("Sandbox ACP recovery started", { sandboxId: instance.id, machineId: instance.machineId });
    if (await this.readMachineReady(instance.machineId)) return;
    if (waitFirst && (await wait())) return;
    if (priorAction === "replace") return fail(instance);
    if (!isCurrent()) throw new SandboxStateError("sandbox recovery intent superseded");
    const repaired =
      priorAction === "resume"
        ? { instance, replaced: false }
        : await this.manager.repairRuntime(instance.id, {
            isCurrent,
            expectedExternalSandboxId: instance.externalSandboxId,
          });
    if (priorAction !== "resume" && (await wait())) {
      logger.info("Sandbox ACP recovery completed", { sandboxId: instance.id, elapsedMs: Date.now() - startedAt });
      return;
    }
    if (repaired.replaced) return fail(repaired.instance);
    const rebuilt = await this.manager.repairRuntime(instance.id, {
      recreate: true,
      expectedExternalSandboxId: repaired.instance.externalSandboxId,
      isCurrent,
    });
    if (!(await wait())) return fail(rebuilt.instance);
    logger.info("Sandbox ACP recovery completed", { sandboxId: instance.id, elapsedMs: Date.now() - startedAt });
  }
}

/** 取消单个等待者，不把请求的 AbortSignal 传给共享 Provider 操作。 */
async function waitForRecovery(work: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return work;
  signal.throwIfAborted();
  let abort = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason ?? new DOMException("Operation aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    await Promise.race([work, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
