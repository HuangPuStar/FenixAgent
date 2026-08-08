import { describe, expect, test } from "bun:test";
import { createReconnectScheduler } from "../reconnect-scheduler";

describe("ReconnectScheduler", () => {
  // 网络错误和 close 事件同时到达时，只安排一次重连。
  test("deduplicates reconnect scheduling across error and close events", () => {
    const callbacks: Array<() => void> = [];
    let connectCount = 0;
    const scheduler = createReconnectScheduler({
      connect: () => {
        connectCount += 1;
      },
      setTimeout: (callback) => {
        callbacks.push(callback);
        return callbacks.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: () => {},
    });

    expect(scheduler.schedule()).toBe(true);
    expect(scheduler.schedule()).toBe(false);
    expect(callbacks).toHaveLength(1);

    callbacks[0]!();
    expect(connectCount).toBe(1);
  });

  // 一次重连完成后，后续断连仍然可以再次安排重连。
  test("allows scheduling again after the reconnect callback runs", () => {
    const callbacks: Array<() => void> = [];
    const scheduler = createReconnectScheduler({
      connect: () => {},
      setTimeout: (callback) => {
        callbacks.push(callback);
        return callbacks.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: () => {},
    });

    expect(scheduler.schedule()).toBe(true);
    callbacks[0]!();
    expect(scheduler.schedule()).toBe(true);
  });
});
