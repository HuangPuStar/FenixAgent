import { createLogger } from "@fenix/logger";
import { config } from "../../config";
import { type MachineStatusReader, waitForMachineConnection } from "../machine-connection-waiter";
import { SandboxRuntimeNotReadyError } from "./sandbox-errors";
import type { SandboxManager, SandboxManagerCreateInput } from "./sandbox-manager";

const logger = createLogger("sandbox-execution");

export type PreparedExecutionNode = {
  nodeId: string;
  source: "sandbox";
  sandboxId: string;
};

export type SandboxExecutionInput = Omit<SandboxManagerCreateInput, "poolId" | "providerKey" | "template"> & {
  sandboxPoolId: string;
  organizationId?: string;
  runtimeConnectTimeoutMs?: number;
};

/** 创建或复用 Sandbox，并等待其对应 Machine 使用现有 ACP 注册流程回连。 */
export class SandboxExecutionHandler {
  constructor(
    private readonly manager: SandboxManager,
    private readonly readMachineOnline?: MachineStatusReader,
  ) {}

  async prepare(input: SandboxExecutionInput): Promise<PreparedExecutionNode> {
    const pool = await this.manager.getPool(input.sandboxPoolId, input.organizationId);
    const instance = await this.manager.createOrReuse({
      ...input,
      poolId: pool.id,
      providerKey: pool.providerKey,
      template: { type: "image", value: pool.image },
      organizationId: input.organizationId,
    });

    const runtimeConnectTimeoutMs = input.runtimeConnectTimeoutMs ?? config.sandboxRuntimeConnectTimeoutMs;
    const waitForConnection = (machineId: string) =>
      waitForMachineConnection(machineId, runtimeConnectTimeoutMs, this.readMachineOnline);

    try {
      await waitForConnection(instance.machineId);
    } catch {
      logger.warn(`[prepare] first ACP wait timed out, retrying provider resource sandboxId='${instance.id}'`);
      try {
        const restarted = await this.manager.restart(instance.id);
        logger.info(`[prepare] provider retry completed, waiting for ACP sandboxId='${restarted.id}'`);
        await waitForConnection(restarted.machineId);
      } catch {
        logger.warn(`[prepare] provider retry failed, rebuilding sandboxId='${instance.id}'`);
        try {
          const recovered = await this.manager.recover(instance.id);
          logger.info(`[prepare] recovery completed, waiting for ACP sandboxId='${recovered.id}'`);
          await waitForConnection(recovered.machineId);
        } catch {
          logger.error(`[prepare] ACP wait failed after provider retry and recovery sandboxId='${instance.id}'`);
          await this.manager.markError(instance.id, "sandbox ACP runtime did not connect in time");
          throw new SandboxRuntimeNotReadyError(instance.id);
        }
      }
    }

    return { nodeId: instance.machineId, source: "sandbox", sandboxId: instance.id };
  }
}
