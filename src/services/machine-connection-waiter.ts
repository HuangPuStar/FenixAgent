import { isMachineOnline } from "../repositories/machine-repository";

export type MachineStatusReader = (machineId: string) => Promise<boolean>;
export type MachineSleep = (delayMs: number) => Promise<void>;

export const DEFAULT_MACHINE_CONNECTION_TIMEOUT_MS = 30_000;

const DEFAULT_POLL_DELAY_MS = 1_000;

const sleep: MachineSleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));

/** 通过共享数据库轮询 Machine 状态，避免依赖单进程内的连接事件。 */
export async function waitForMachineConnection(
  machineId: string,
  timeoutMs: number,
  readMachineOnline: MachineStatusReader = isMachineOnline,
  wait: MachineSleep = sleep,
): Promise<void> {
  if (await readMachineOnline(machineId)) return;

  const deadline = Date.now() + timeoutMs;
  let pollDelayMs = DEFAULT_POLL_DELAY_MS;
  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(`machine '${machineId}' connection timed out`);
    }

    await wait(Math.min(pollDelayMs, remainingMs));
    if (await readMachineOnline(machineId)) return;
    pollDelayMs += DEFAULT_POLL_DELAY_MS;
  }
}
