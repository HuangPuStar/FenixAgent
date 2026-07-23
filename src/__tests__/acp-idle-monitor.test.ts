import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setConfig } from "../config";
import {
  listInstanceActivitySnapshots,
  resetAcpIdleMonitorDeps,
  runAcpIdleMonitorSweep,
  setAcpIdleMonitorDeps,
  shouldCountInstanceActivity,
} from "../services/acp-idle-monitor";
import type { SpawnedInstance } from "../services/instance";
import { globalInstanceRegistry } from "../services/instance-registry";

function makeInstance(id: string, environmentId: string): SpawnedInstance {
  return {
    id,
    userId: "user-1",
    port: 0,
    pid: null,
    status: "running",
    command: "",
    error: null,
    apiKey: "",
    createdAt: new Date("2026-06-24T00:00:00Z"),
    environmentId,
    sessionId: undefined,
    instanceNumber: 1,
  };
}

describe("acp idle monitor", () => {
  beforeEach(() => {
    globalInstanceRegistry.clear();
    resetAcpIdleMonitorDeps();
    setConfig({
      acpIdleTimeoutSeconds: 1200,
      acpIdleSweepIntervalSeconds: 60,
      acpActivityTimeoutSeconds: 3600,
    });
  });

  afterEach(() => {
    globalInstanceRegistry.clear();
    resetAcpIdleMonitorDeps();
  });

  // 心跳和保活消息不应计入业务活跃时间
  test("shouldCountInstanceActivity ignores keepalive noise", () => {
    expect(shouldCountInstanceActivity({ type: "keep_alive" })).toBe(false);
    expect(shouldCountInstanceActivity({ type: "heartbeat" })).toBe(false);
    expect(shouldCountInstanceActivity({ type: "ping" })).toBe(false);
    expect(shouldCountInstanceActivity({ type: "pong" })).toBe(false);
    expect(shouldCountInstanceActivity({ type: "session_data" })).toBe(true);
    expect(shouldCountInstanceActivity({ jsonrpc: "2.0", method: "session/list" })).toBe(true);
  });

  // 仅无 relay 且空闲超过阈值的实例才会被标记为可回收
  test("listInstanceActivitySnapshots exposes idle eligibility", () => {
    const idleInstance = makeInstance("inst_idle", "env-1");
    const busyInstance = makeInstance("inst_busy", "env-2");
    globalInstanceRegistry.register(idleInstance.id, {
      userId: "user-1",
      environmentId: "env-1",
      instanceNumber: 1,
      organizationId: "org-1",
      spawnSource: "interactive",
      lastActivityAt: 1000,
      relayCount: 0,
      lastRelayDetachedAt: 1000,
    });
    globalInstanceRegistry.register(busyInstance.id, {
      userId: "user-1",
      environmentId: "env-2",
      instanceNumber: 1,
      organizationId: "org-1",
      spawnSource: "interactive",
      lastActivityAt: 2000,
      relayCount: 1,
      lastRelayDetachedAt: null,
    });
    setAcpIdleMonitorDeps({
      getCoreRuntime: () =>
        ({
          listInstances: () => [
            { instanceId: idleInstance.id, status: "running" },
            { instanceId: busyInstance.id, status: "running" },
          ],
        }) as unknown as ReturnType<typeof import("../services/core-bootstrap").getCoreRuntime>,
      getInstance: (instanceId: string) => {
        if (instanceId === idleInstance.id) return idleInstance;
        if (instanceId === busyInstance.id) return busyInstance;
        return;
      },
    });

    const snapshots = listInstanceActivitySnapshots(1000 + 1200 * 1000, "org-1");
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]?.id).toBe("inst_idle");
    expect(snapshots[0]?.idle_kill_eligible).toBe(true);
    expect(snapshots[0]?.activity_kill_eligible).toBe(false);
    expect(snapshots[1]?.id).toBe("inst_busy");
    expect(snapshots[1]?.idle_kill_eligible).toBe(false);
    expect(snapshots[1]?.activity_kill_eligible).toBe(false);
  });

  // 全局统计应包含没有 supplement 的活跃 runtime 实例；按组织过滤时则应跳过。
  test("listInstanceActivitySnapshots includes runtime-only instances only in global view", () => {
    const trackedInstance = makeInstance("inst_tracked", "env-1");
    globalInstanceRegistry.register(trackedInstance.id, {
      userId: "user-1",
      environmentId: "env-1",
      instanceNumber: 1,
      organizationId: "org-1",
      spawnSource: "interactive",
      lastActivityAt: 1000,
      relayCount: 0,
      lastRelayDetachedAt: 1000,
    });

    setAcpIdleMonitorDeps({
      getCoreRuntime: () =>
        ({
          listInstances: () => [
            {
              instanceId: trackedInstance.id,
              status: "running",
              createdAt: new Date("2026-06-24T00:00:00Z"),
              errorMessage: null,
              pluginMetadata: {},
            },
            {
              instanceId: "inst_runtime_only",
              status: "running",
              createdAt: new Date("2026-06-24T00:00:00Z"),
              errorMessage: null,
              pluginMetadata: { port: 9527 },
            },
          ],
        }) as unknown as ReturnType<typeof import("../services/core-bootstrap").getCoreRuntime>,
      getInstance: (instanceId: string) => {
        if (instanceId === trackedInstance.id) return trackedInstance;
        return;
      },
    });

    const globalSnapshots = listInstanceActivitySnapshots(1000 + 1200 * 1000);
    expect(globalSnapshots.map((item) => item.id)).toContain("inst_runtime_only");
    expect(globalSnapshots.find((item) => item.id === "inst_runtime_only")).toMatchObject({
      environment_id: null,
      instance_number: 0,
      port: 9527,
    });

    const orgSnapshots = listInstanceActivitySnapshots(1000 + 1200 * 1000, "org-1");
    expect(orgSnapshots.map((item) => item.id)).toEqual(["inst_tracked"]);
  });

  // sweep 只会停止满足空闲条件的实例
  test("runAcpIdleMonitorSweep stops only eligible idle instances", async () => {
    const stopCalls: Array<{ instanceId: string; organizationId: string }> = [];
    const idleInstance = makeInstance("inst_idle", "env-1");
    const activeInstance = makeInstance("inst_active", "env-2");
    globalInstanceRegistry.register(idleInstance.id, {
      userId: "user-1",
      environmentId: "env-1",
      instanceNumber: 1,
      organizationId: "org-1",
      spawnSource: "interactive",
      lastActivityAt: 1000,
      relayCount: 0,
      lastRelayDetachedAt: 1000,
    });
    globalInstanceRegistry.register(activeInstance.id, {
      userId: "user-1",
      environmentId: "env-2",
      instanceNumber: 1,
      organizationId: "org-1",
      spawnSource: "interactive",
      lastActivityAt: 1000,
      relayCount: 1,
      lastRelayDetachedAt: null,
    });
    setAcpIdleMonitorDeps({
      getCoreRuntime: () =>
        ({
          listInstances: () => [
            { instanceId: idleInstance.id, status: "running" },
            { instanceId: activeInstance.id, status: "running" },
          ],
        }) as unknown as ReturnType<typeof import("../services/core-bootstrap").getCoreRuntime>,
      getInstance: (instanceId: string) => {
        if (instanceId === idleInstance.id) return idleInstance;
        if (instanceId === activeInstance.id) return activeInstance;
        return;
      },
      stopInstance: async (instanceId: string, organizationId: string) => {
        stopCalls.push({ instanceId, organizationId });
        return { ok: true as const };
      },
    });

    await runAcpIdleMonitorSweep(1000 + 1201 * 1000);
    expect(stopCalls).toEqual([{ instanceId: "inst_idle", organizationId: "org-1" }]);
  });

  // 即使 relay 仍存在，只要长时间没有 ACP 业务活动，也会触发硬超时回收
  test("runAcpIdleMonitorSweep stops instances with stale ACP activity even when relay is attached", async () => {
    const stopCalls: Array<{ instanceId: string; organizationId: string }> = [];
    const staleInstance = makeInstance("inst_stale", "env-1");
    globalInstanceRegistry.register(staleInstance.id, {
      userId: "user-1",
      environmentId: "env-1",
      instanceNumber: 1,
      organizationId: "org-1",
      spawnSource: "interactive",
      lastActivityAt: 1000,
      relayCount: 1,
      lastRelayDetachedAt: null,
    });
    setAcpIdleMonitorDeps({
      getCoreRuntime: () =>
        ({
          listInstances: () => [{ instanceId: staleInstance.id, status: "running" }],
        }) as unknown as ReturnType<typeof import("../services/core-bootstrap").getCoreRuntime>,
      getInstance: (instanceId: string) => {
        if (instanceId === staleInstance.id) return staleInstance;
        return;
      },
      stopInstance: async (instanceId: string, organizationId: string) => {
        stopCalls.push({ instanceId, organizationId });
        return { ok: true as const };
      },
    });

    await runAcpIdleMonitorSweep(1000 + 3601 * 1000);
    expect(stopCalls).toEqual([{ instanceId: "inst_stale", organizationId: "org-1" }]);
  });
});
