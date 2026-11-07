/**
 * P0-07 回归：心跳持久化失败与旧 timeout 回调不得把健康 machine 判离线。
 *
 * 依赖经 `setRegistryHeartbeatDeps` 注入，时间由 bun:test 的 fake timers 控制；
 * 不接触真实 DB，也不替换模块（禁止 mock.module）。
 */
import { afterEach, beforeEach, describe, expect, jest, setSystemTime, test } from "bun:test";
import {
  bindMachineLifecyclePort,
  handleHeartbeat,
  resetMachineLifecyclePortForTest,
  resetRegistryHeartbeatDeps,
  setRegistryHeartbeatDeps,
  startHeartbeat,
  stopHeartbeat,
} from "@fenix/resource-machine/server";
import { initializeMachineModuleConfig } from "../server/testing";

const MACHINE = "mach_p0_07_race";
const INTERVAL = 30_000;
const TIMEOUT = INTERVAL * 3;

let events: string[];

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 让已排队的微任务跑完；fake timer 回调内部是 async 函数，不 await 时只能靠它推进。 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  events = [];
  jest.useFakeTimers();
  setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  initializeMachineModuleConfig();
  resetMachineLifecyclePortForTest();
  bindMachineLifecyclePort({
    notifyMachineRegistered: async () => {},
    notifyMachineHeartbeat: async () => {},
  });
});

afterEach(() => {
  stopHeartbeat(MACHINE);
  resetRegistryHeartbeatDeps();
  resetMachineLifecyclePortForTest();
  jest.useRealTimers();
});

describe("registry heartbeat 代次与存活判定", () => {
  // 超时落库缓慢期间同一连接的新心跳成功：旧回调完成时不得删除新计时器或断连。
  test("timeout 落库期间的新心跳使旧回调失效", async () => {
    const releaseTimeoutWrite = deferred();
    setRegistryHeartbeatDeps({
      updateHeartbeat: async () => {
        events.push("heartbeat persisted");
      },
      markHeartbeatTimeout: async () => {
        events.push("timeout write started");
        await releaseTimeoutWrite.promise;
        events.push("timeout write completed");
      },
    });

    startHeartbeat(MACHINE, INTERVAL, () => events.push("disconnect"), "ws-old");
    jest.advanceTimersByTime(TIMEOUT);
    await flushMicrotasks();
    expect(events).toEqual(["timeout write started"]);

    await handleHeartbeat(MACHINE, "ws-old");
    expect(events).toEqual(["timeout write started", "heartbeat persisted"]);

    releaseTimeoutWrite.resolve();
    await flushMicrotasks();
    expect(events).toEqual(["timeout write started", "heartbeat persisted", "timeout write completed"]);
    expect(events).not.toContain("disconnect");

    // 新计时器仍归当前 entry 所有：stop 必须能清除它，之后不再触发超时。
    stopHeartbeat(MACHINE, "ws-old");
    jest.advanceTimersByTime(TIMEOUT * 2);
    await flushMicrotasks();
    expect(events).not.toContain("disconnect");
  });

  // 持久化连续阻塞/拒绝超过 90 秒，真实到达的心跳仍保持在线；真正停跳后只超时一次。
  test("持久化失败或阻塞时真实心跳仍刷新存活期限", async () => {
    let calls = 0;
    setRegistryHeartbeatDeps({
      updateHeartbeat: () => {
        calls += 1;
        // 前两次永久阻塞、之后拒绝：两种故障都只能影响观测，不得改写内存存活期限。
        return calls <= 2 ? new Promise<void>(() => {}) : Promise.reject(new Error("database unavailable"));
      },
      markHeartbeatTimeout: async () => {
        events.push("timeout");
      },
    });

    startHeartbeat(MACHINE, INTERVAL, () => events.push("disconnect"), "ws-1");
    for (let i = 0; i < 4; i++) {
      jest.advanceTimersByTime(INTERVAL);
      void handleHeartbeat(MACHINE, "ws-1");
      await flushMicrotasks();
    }
    expect(events).toEqual([]);

    // 心跳停止后，真实超时仍按预期触发，且不会重复清理。
    jest.advanceTimersByTime(TIMEOUT);
    await flushMicrotasks();
    expect(events).toEqual(["timeout", "disconnect"]);

    jest.advanceTimersByTime(TIMEOUT * 2);
    await flushMicrotasks();
    expect(events).toEqual(["timeout", "disconnect"]);
  });

  // 重新注册接管后，旧连接的在途超时回调与旧连接 stop 都不得影响新计时器。
  test("旧超时回调与旧连接 stop 不影响重新注册的新连接", async () => {
    const releaseOldWrite = deferred();
    setRegistryHeartbeatDeps({
      updateHeartbeat: async () => {},
      markHeartbeatTimeout: async () => {
        events.push("timeout write");
        await releaseOldWrite.promise;
      },
    });

    startHeartbeat(MACHINE, INTERVAL, () => events.push("old disconnect"), "ws-old");
    jest.advanceTimersByTime(TIMEOUT);
    await flushMicrotasks();
    expect(events).toEqual(["timeout write"]);

    // 新连接接管：旧计时器被替换；旧连接的 stop 只作用于自己的代次。
    startHeartbeat(MACHINE, INTERVAL, () => events.push("new disconnect"), "ws-new");
    stopHeartbeat(MACHINE, "ws-old");

    releaseOldWrite.resolve();
    await flushMicrotasks();
    expect(events).not.toContain("old disconnect");

    // 新连接仍持有有效计时器：推进到自己的截止时间只触发一次新回调。
    events = [];
    jest.advanceTimersByTime(TIMEOUT);
    await flushMicrotasks();
    expect(events).toEqual(["timeout write", "new disconnect"]);
  });

  // 旧连接残留的心跳不得延长新连接的存活期限。
  test("旧连接心跳不刷新新连接的计时器", async () => {
    setRegistryHeartbeatDeps({
      updateHeartbeat: async () => {},
      markHeartbeatTimeout: async () => {},
    });

    startHeartbeat(MACHINE, INTERVAL, () => events.push("old disconnect"), "ws-old");
    startHeartbeat(MACHINE, INTERVAL, () => events.push("new disconnect"), "ws-new");
    await handleHeartbeat(MACHINE, "ws-old");

    jest.advanceTimersByTime(TIMEOUT);
    await flushMicrotasks();
    expect(events).toEqual(["new disconnect"]);
  });
});
