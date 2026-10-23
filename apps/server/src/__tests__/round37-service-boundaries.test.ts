import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { getAcpEventBus, getEventBus, removeAcpEventBus, removeEventBus } from "@fenix/agent-runtime/server";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import { waitForMachineConnection } from "@fenix/resource-machine/server";
import { SandboxExecutionHandler } from "@fenix/resource-sandbox/server";

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
      expect(delays).toEqual([...item.expectedDelays]);
    });
  }

  for (const timeoutMs of [0, -1, -100, 1, 2, 5, 10, 20, 50, 100] as const) {
    // 用可控时钟验证剩余预算，避免毫秒级调度抖动改变等待次数。
    test(`机器连接超时 ${timeoutMs}ms 时按剩余时间截断等待`, async () => {
      let now = 10_000;
      const clock = spyOn(Date, "now").mockImplementation(() => now);
      const delays: number[] = [];

      try {
        await expect(
          waitForMachineConnection(
            `mach-timeout-${timeoutMs}`,
            timeoutMs,
            async () => false,
            async (delayMs) => {
              delays.push(delayMs);
              now += delayMs;
            },
          ),
        ).rejects.toThrow("connection timed out");
        expect(delays).toEqual(timeoutMs <= 0 ? [] : [timeoutMs]);
      } finally {
        clock.mockRestore();
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
    repairRuntime: async (_id: string, options: { recreate?: boolean }) => {
      if (options.recreate) {
        calls.recover += 1;
        if (mode === "recover") online = true;
      } else {
        calls.restart += 1;
        if (mode === "restart") online = true;
      }
      return { instance, replaced: Boolean(options.recreate) };
    },
    markRuntimeNotReady: async () => {
      calls.markError += 1;
    },
  };
  return { calls, manager, readOnline: async () => online };
}

const executionCases = Array.from(
  { length: 15 },
  (_, index) => `sandbox-boundary-${String(index + 1).padStart(2, "0")}`,
);

/**
 * 补偿边界用例的连接等待超时：首次等待必须超时（readOnline 初始 false），重启/恢复后的等待必须成功。
 * 两次等待共用此值——取 1ms 时"成功"那次只剩 1ms 判定窗口，负载下被调度抖动吃掉会让补偿多走一级
 * （recover 被意外调用）而断言失败，即 `scripts/ci.ts` 记录的已知偶发；50ms 足以覆盖判定路径
 * （入口检查 + 一次 readOnline 微任务）。
 */
const BOUNDARY_CONNECT_TIMEOUT_MS = 50;

describe("Sandbox ACP 错误补偿边界", () => {
  for (const sandboxId of executionCases) {
    // 首次等待失败后仍应先复用原资源。
    test(`Sandbox ${sandboxId} 首次等待失败后重启资源并补偿为可连接状态`, async () => {
      const fixture = makeExecutionManager(sandboxId, "restart");
      const handler = new SandboxExecutionHandler(fixture.manager as never, fixture.readOnline);
      await expect(
        handler.prepare({
          sandboxId,
          sandboxPoolId: "pool-boundary",
          userId: "user-a",
          runtimeConnectTimeoutMs: BOUNDARY_CONNECT_TIMEOUT_MS,
        }),
      ).resolves.toEqual({ nodeId: `mach_sandbox_${sandboxId}`, source: "sandbox", sandboxId });
      expect(fixture.calls).toEqual({ restart: 1, recover: 0, markError: 0 });
    });
  }

  for (const sandboxId of executionCases) {
    // 只有连接继续超时才推进到单次重建。
    test(`Sandbox ${sandboxId} 重试超时后重建资源并补偿为可连接状态`, async () => {
      const fixture = makeExecutionManager(sandboxId, "recover");
      const handler = new SandboxExecutionHandler(fixture.manager as never, fixture.readOnline);
      await expect(
        handler.prepare({
          sandboxId,
          sandboxPoolId: "pool-boundary",
          userId: "user-a",
          runtimeConnectTimeoutMs: BOUNDARY_CONNECT_TIMEOUT_MS,
        }),
      ).resolves.toEqual({ nodeId: `mach_sandbox_${sandboxId}`, source: "sandbox", sandboxId });
      expect(fixture.calls).toEqual({ restart: 1, recover: 1, markError: 0 });
    });
  }

  for (const sandboxId of executionCases) {
    // 重建也未连接时应明确失败，不能无限重试。
    test(`Sandbox ${sandboxId} 重试与重建后仍未回连时标记错误且拒绝执行`, async () => {
      const fixture = makeExecutionManager(sandboxId, "error");
      const handler = new SandboxExecutionHandler(fixture.manager as never, fixture.readOnline);
      await expect(
        handler.prepare({
          sandboxId,
          sandboxPoolId: "pool-boundary",
          userId: "user-a",
          runtimeConnectTimeoutMs: BOUNDARY_CONNECT_TIMEOUT_MS,
        }),
      ).rejects.toThrow(sandboxId);
      expect(fixture.calls).toEqual({ restart: 1, recover: 1, markError: 1 });
    });
  }
});
