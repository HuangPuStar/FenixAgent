import { afterEach, describe, expect, test } from "bun:test";
import { waitForMachineConnection } from "../services/machine-connection-waiter";
import { SandboxExecutionHandler } from "../services/sandbox/sandbox-execution-handler";
import { resetAllStubs } from "../test-utils/helpers";
import { getAcpEventBus, getEventBus, removeAcpEventBus, removeEventBus } from "../transport/event-bus";

afterEach(() => {
  resetAllStubs();
});

const connectionCases = [
  { id: "mach-connect-01", onlineOnRead: 2, expectedDelays: [1000] },
  { id: "mach-connect-02", onlineOnRead: 3, expectedDelays: [1000, 2000] },
  { id: "mach-connect-03", onlineOnRead: 4, expectedDelays: [1000, 2000, 3000] },
  { id: "mach-connect-04", onlineOnRead: 5, expectedDelays: [1000, 2000, 3000, 4000] },
  { id: "mach-connect-05", onlineOnRead: 6, expectedDelays: [1000, 2000, 3000, 4000, 5000] },
  { id: "mach-connect-06", onlineOnRead: 2, expectedDelays: [1000] },
  { id: "mach-connect-07", onlineOnRead: 3, expectedDelays: [1000, 2000] },
  { id: "mach-connect-08", onlineOnRead: 4, expectedDelays: [1000, 2000, 3000] },
  { id: "mach-connect-09", onlineOnRead: 5, expectedDelays: [1000, 2000, 3000, 4000] },
  { id: "mach-connect-10", onlineOnRead: 6, expectedDelays: [1000, 2000, 3000, 4000, 5000] },
  { id: "mach-connect-11", onlineOnRead: 2, expectedDelays: [1000] },
  { id: "mach-connect-12", onlineOnRead: 3, expectedDelays: [1000, 2000] },
  { id: "mach-connect-13", onlineOnRead: 4, expectedDelays: [1000, 2000, 3000] },
  { id: "mach-connect-14", onlineOnRead: 5, expectedDelays: [1000, 2000, 3000, 4000] },
  { id: "mach-connect-15", onlineOnRead: 6, expectedDelays: [1000, 2000, 3000, 4000, 5000] },
  { id: "mach-connect-16", onlineOnRead: 2, expectedDelays: [1000] },
  { id: "mach-connect-17", onlineOnRead: 3, expectedDelays: [1000, 2000] },
  { id: "mach-connect-18", onlineOnRead: 4, expectedDelays: [1000, 2000, 3000] },
  { id: "mach-connect-19", onlineOnRead: 5, expectedDelays: [1000, 2000, 3000, 4000] },
  { id: "mach-connect-20", onlineOnRead: 6, expectedDelays: [1000, 2000, 3000, 4000, 5000] },
  { id: "mach-connect-21", onlineOnRead: 2, expectedDelays: [1000] },
  { id: "mach-connect-22", onlineOnRead: 3, expectedDelays: [1000, 2000] },
  { id: "mach-connect-23", onlineOnRead: 4, expectedDelays: [1000, 2000, 3000] },
  { id: "mach-connect-24", onlineOnRead: 5, expectedDelays: [1000, 2000, 3000, 4000] },
  { id: "mach-connect-25", onlineOnRead: 6, expectedDelays: [1000, 2000, 3000, 4000, 5000] },
] as const;

describe("机器连接轮询边界", () => {
  for (const item of connectionCases) {
    test(`机器 ${item.id} 在第 ${item.onlineOnRead} 次读取后上线时按退避间隔完成连接`, async () => {
      let reads = 0;
      const delays: number[] = [];
      await waitForMachineConnection(
        item.id,
        60_000,
        async () => ++reads === item.onlineOnRead,
        async (delayMs) => {
          delays.push(delayMs);
        },
      );
      expect(reads).toBe(item.onlineOnRead);
      expect(delays).toEqual(item.expectedDelays);
    });
  }

  for (const timeoutMs of [0, -1, -100, 1, 2, 5, 10, 20, 50, 100] as const) {
    test(`机器连接超时 ${timeoutMs}ms 时按剩余时间截断等待`, async () => {
      let waits = 0;
      const delays: number[] = [];
      await expect(
        waitForMachineConnection(
          `mach-timeout-${timeoutMs}`,
          timeoutMs,
          async () => false,
          async (delayMs) => {
            waits += 1;
            delays.push(delayMs);
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          },
        ),
      ).rejects.toThrow("connection timed out");
      if (timeoutMs <= 0) {
        expect(waits).toBe(0);
      } else {
        expect(waits).toBe(1);
        expect(delays[0]).toBeLessThanOrEqual(timeoutMs);
      }
    });
  }
});

const eventCases = Array.from({ length: 25 }, (_, index) => ({
  sessionId: `session-isolated-${String(index + 1).padStart(2, "0")}`,
  type: index % 2 === 0 ? "message" : "tool-result",
  direction: index % 2 === 0 ? ("inbound" as const) : ("outbound" as const),
}));

describe("事件总线会话与 ACP 组织隔离", () => {
  for (const item of eventCases) {
    test(`会话 ${item.sessionId} 的事件不会泄漏给相邻会话`, () => {
      const neighborId = `${item.sessionId}-neighbor`;
      removeEventBus(item.sessionId);
      removeEventBus(neighborId);
      const sessionBus = getEventBus(item.sessionId);
      const neighborBus = getEventBus(neighborId);
      const payload = { organizationId: "org-a", userId: "user-a", request: item.sessionId };

      const event = sessionBus.publish({
        id: `evt-${item.sessionId}`,
        sessionId: item.sessionId,
        type: item.type,
        payload,
        direction: item.direction,
      });

      expect(event.seqNum).toBe(1);
      expect(sessionBus.getEventsSince(0)).toEqual([event]);
      expect(neighborBus.getEventsSince(0)).toEqual([]);
      removeEventBus(item.sessionId);
      removeEventBus(neighborId);
    });
  }

  for (const item of eventCases) {
    test(`ACP 频道组 ${item.sessionId} 删除后重建为独立事件流`, () => {
      const groupId = `acp-${item.sessionId}`;
      removeAcpEventBus(groupId);
      const initial = getAcpEventBus(groupId);
      initial.publish({
        id: `evt-before-${item.sessionId}`,
        sessionId: item.sessionId,
        type: item.type,
        payload: { organizationId: "org-a", stage: "before" },
        direction: item.direction,
      });
      removeAcpEventBus(groupId);

      const rebuilt = getAcpEventBus(groupId);
      expect(rebuilt).not.toBe(initial);
      expect(rebuilt.getLastSeqNum()).toBe(0);
      expect(rebuilt.getEventsSince(0)).toEqual([]);
      removeAcpEventBus(groupId);
    });
  }
});

function makeExecutionManager(sandboxId: string, mode: "restart" | "recover" | "error") {
  let online = false;
  const calls = { restart: 0, recover: 0, markError: 0 };
  const machineId = `mach_sandbox_${sandboxId}`;
  const instance = { id: sandboxId, machineId, status: "creating" };
  const manager = {
    getPool: async () => ({ id: "pool-boundary", providerKey: "provider-boundary", image: "sandbox:test" }),
    createOrReuse: async () => instance,
    restart: async () => {
      calls.restart += 1;
      if (mode === "restart") online = true;
      if (mode === "error") throw new Error("provider restart failed");
      return instance;
    },
    recover: async () => {
      calls.recover += 1;
      if (mode === "recover") online = true;
      if (mode === "error") throw new Error("provider recovery failed");
      return instance;
    },
    markError: async () => {
      calls.markError += 1;
      return instance;
    },
  };
  return { calls, manager, readOnline: async () => online };
}

const executionCases = Array.from(
  { length: 15 },
  (_, index) => `sandbox-boundary-${String(index + 1).padStart(2, "0")}`,
);

describe("Sandbox ACP 错误补偿边界", () => {
  for (const sandboxId of executionCases) {
    test(`Sandbox ${sandboxId} 首次等待失败后重启资源并补偿为可连接状态`, async () => {
      const fixture = makeExecutionManager(sandboxId, "restart");
      const handler = new SandboxExecutionHandler(fixture.manager as never, fixture.readOnline);
      await expect(
        handler.prepare({
          sandboxId,
          sandboxPoolId: "pool-boundary",
          userId: "user-a",
          runtimeConnectTimeoutMs: 1,
        }),
      ).resolves.toEqual({ nodeId: `mach_sandbox_${sandboxId}`, source: "sandbox", sandboxId });
      expect(fixture.calls).toEqual({ restart: 1, recover: 0, markError: 0 });
    });
  }

  for (const sandboxId of executionCases) {
    test(`Sandbox ${sandboxId} 重启失败后恢复资源并补偿为可连接状态`, async () => {
      const fixture = makeExecutionManager(sandboxId, "recover");
      const handler = new SandboxExecutionHandler(fixture.manager as never, fixture.readOnline);
      await expect(
        handler.prepare({
          sandboxId,
          sandboxPoolId: "pool-boundary",
          userId: "user-a",
          runtimeConnectTimeoutMs: 1,
        }),
      ).resolves.toEqual({ nodeId: `mach_sandbox_${sandboxId}`, source: "sandbox", sandboxId });
      expect(fixture.calls).toEqual({ restart: 1, recover: 1, markError: 0 });
    });
  }

  for (const sandboxId of executionCases) {
    test(`Sandbox ${sandboxId} 重启和恢复均失败时标记错误且拒绝执行`, async () => {
      const fixture = makeExecutionManager(sandboxId, "error");
      const handler = new SandboxExecutionHandler(fixture.manager as never, fixture.readOnline);
      await expect(
        handler.prepare({
          sandboxId,
          sandboxPoolId: "pool-boundary",
          userId: "user-a",
          runtimeConnectTimeoutMs: 1,
        }),
      ).rejects.toThrow(sandboxId);
      expect(fixture.calls).toEqual({ restart: 1, recover: 1, markError: 1 });
    });
  }
});
