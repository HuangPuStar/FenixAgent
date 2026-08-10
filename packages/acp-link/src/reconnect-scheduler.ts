export type ReconnectTimer = ReturnType<typeof setTimeout>;

type ReconnectSchedulerOptions = {
  connect: () => void;
  setTimeout?: (callback: () => void, delayMs: number) => ReconnectTimer;
  clearTimeout?: (timer: ReconnectTimer) => void;
};

/**
 * 合并 WebSocket error/close 事件触发的重连任务，避免同一个断连安排多个连接。
 */
export function createReconnectScheduler(options: ReconnectSchedulerOptions) {
  const scheduleTimeout: NonNullable<ReconnectSchedulerOptions["setTimeout"]> =
    options.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs) as ReconnectTimer);
  const cancelTimeout: NonNullable<ReconnectSchedulerOptions["clearTimeout"]> = options.clearTimeout ?? clearTimeout;
  let timer: ReconnectTimer | null = null;

  return {
    schedule(delayMs = 0): boolean {
      if (timer !== null) return false;
      timer = scheduleTimeout(() => {
        timer = null;
        options.connect();
      }, delayMs);
      return true;
    },

    cancel(): void {
      if (timer === null) return;
      cancelTimeout(timer);
      timer = null;
    },
  };
}
