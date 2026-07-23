import { beforeEach, describe, expect, test } from "bun:test";
import type { RuntimeInstanceSnapshot } from "@fenix/core";
import {
  getActiveAgentCount,
  getActiveScheduledAgentCount,
  isActiveRuntimeStatus,
} from "../services/agent-concurrency";
import { globalInstanceRegistry } from "../services/instance-registry";
import type { InstanceSupplement } from "../types/store";

function makeSnapshot(instanceId: string, status: RuntimeInstanceSnapshot["status"]): RuntimeInstanceSnapshot {
  return {
    instanceId,
    status,
    createdAt: new Date("2026-07-23T00:00:00Z"),
    errorMessage: undefined,
    pluginMetadata: {},
  } as unknown as RuntimeInstanceSnapshot;
}

function makeSupplement(overrides: Partial<InstanceSupplement> = {}): InstanceSupplement {
  return {
    userId: "user-1",
    environmentId: "env-1",
    instanceNumber: 1,
    organizationId: "org-1",
    spawnSource: "interactive",
    lastActivityAt: Date.now(),
    relayCount: 0,
    lastRelayDetachedAt: Date.now(),
    ...overrides,
  };
}

describe("agent concurrency", () => {
  beforeEach(() => {
    globalInstanceRegistry.clear();
  });

  // 活跃状态统计应排除 stopped/stopping/error
  test("isActiveRuntimeStatus excludes terminal statuses", () => {
    expect(isActiveRuntimeStatus("starting")).toBe(true);
    expect(isActiveRuntimeStatus("running")).toBe(true);
    expect(isActiveRuntimeStatus("stopped")).toBe(false);
    expect(isActiveRuntimeStatus("stopping")).toBe(false);
    expect(isActiveRuntimeStatus("error")).toBe(false);
  });

  // 总并发应统计 runtime 中所有活跃实例，即使没有 supplement
  test("getActiveAgentCount counts all active runtime instances", () => {
    const runtime = {
      listInstances: () => [
        makeSnapshot("inst_1", "running"),
        makeSnapshot("inst_2", "starting"),
        makeSnapshot("inst_3", "stopping"),
        makeSnapshot("inst_4", "error"),
        makeSnapshot("inst_5", "running"),
      ],
    };

    expect(getActiveAgentCount(runtime as never)).toBe(3);
  });

  // 定时任务并发只统计 supplement 中显式标记 scheduled 的活跃实例
  test("getActiveScheduledAgentCount counts only scheduled supplements", () => {
    globalInstanceRegistry.register(
      "inst_scheduled",
      makeSupplement({
        spawnSource: "scheduled",
      }),
    );
    globalInstanceRegistry.register(
      "inst_interactive",
      makeSupplement({
        environmentId: "env-2",
        instanceNumber: 2,
        spawnSource: "interactive",
      }),
    );

    const runtime = {
      listInstances: () => [
        makeSnapshot("inst_scheduled", "running"),
        makeSnapshot("inst_interactive", "running"),
        makeSnapshot("inst_stopped", "stopped"),
      ],
    };

    expect(getActiveScheduledAgentCount(runtime as never, globalInstanceRegistry)).toBe(1);
  });

  // 没有 supplement 的活跃实例不计入 scheduled 并发，但仍计入总并发
  test("getActiveScheduledAgentCount skips runtime-only instances", () => {
    const runtime = {
      listInstances: () => [makeSnapshot("inst_runtime_only", "running")],
    };

    expect(getActiveAgentCount(runtime as never)).toBe(1);
    expect(getActiveScheduledAgentCount(runtime as never, globalInstanceRegistry)).toBe(0);
  });
});
