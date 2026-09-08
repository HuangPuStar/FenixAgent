import { isMachineOnline } from "../repositories/machine-repository";

export type MachineStatusReader = (machineId: string) => Promise<boolean>;
export type MachineSleep = (delayMs: number) => Promise<void>;

export const DEFAULT_MACHINE_CONNECTION_TIMEOUT_MS = 30_000;

const DEFAULT_POLL_DELAY_MS = 1_000;

const sleep: MachineSleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));

export class MachineConnectionTimeoutError extends Error {
  constructor(machineId: string) {
    super(`machine '${machineId}' connection timed out`);
    this.name = "MachineConnectionTimeoutError";
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Operation aborted", "AbortError");
}

async function withDeadline<T>(
  operation: Promise<T>,
  machineId: string,
  deadline: number,
  signal?: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new MachineConnectionTimeoutError(machineId);

  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new MachineConnectionTimeoutError(machineId)), remainingMs);
    const abort = () => reject(signal?.reason ?? new DOMException("Operation aborted", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    });
  });
}

/** 通过共享数据库轮询 Machine 状态，避免依赖单进程内的连接事件。 */
export async function waitForMachineConnection(
  machineId: string,
  timeoutMs: number,
  readMachineOnline: MachineStatusReader = isMachineOnline,
  wait: MachineSleep = sleep,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  if (await withDeadline(readMachineOnline(machineId), machineId, deadline, signal)) return;

  let pollDelayMs = DEFAULT_POLL_DELAY_MS;
  while (true) {
    throwIfAborted(signal);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new MachineConnectionTimeoutError(machineId);

    await withDeadline(wait(Math.min(pollDelayMs, remainingMs)), machineId, deadline, signal);
    if (await withDeadline(readMachineOnline(machineId), machineId, deadline, signal)) return;
    pollDelayMs += DEFAULT_POLL_DELAY_MS;
  }
}
