import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import { initializeAgentRuntimeModuleConfig, stubAgentRuntimeConfig } from "../server/testing";
import { resetAgentConcurrencyDeps, setAgentConcurrencyDeps } from "../services/agent-concurrency";
import { acquireAgentExecution } from "../services/agent-execution-admission";
import { globalInstanceRegistry } from "../services/instance-registry";
import { spawnInstanceViaController } from "../services/orchestration-instance";

function makeRuntime(statuses: Array<"starting" | "running" | "stopped" | "stopping" | "error">) {
  return {
    listInstances: () =>
      statuses.map((status, index) => ({
        instanceId: `inst_${index + 1}`,
        status,
      })),
  };
}

describe("instance concurrency limits", () => {
  beforeEach(() => {
    globalInstanceRegistry.clear();
    resetAgentConcurrencyDeps();
    // 并发上限走模块配置（不再是宿主 config）：缺省基线即「三个上限都不生效」，
    // 需要限额的用例用 stubAgentRuntimeConfig 显式声明。
    initializeAgentRuntimeModuleConfig();
  });

  afterEach(() => {
    globalInstanceRegistry.clear();
    resetAgentConcurrencyDeps();
    resetAllStubs();
  });

  // 总并发超限时应在触达编排域（controller / DB）前直接拒绝
  test("spawnInstanceViaController rejects when total concurrency limit is reached", async () => {
    stubAgentRuntimeConfig({ agentMaxConcurrency: 1 });
    setAgentConcurrencyDeps({
      getRuntime: () => makeRuntime(["running"]) as never,
    });

    await expect(
      spawnInstanceViaController("env-1", "user-1", "interactive", { instanceUid: "inst_test_interactive" }),
    ).rejects.toMatchObject({
      code: "AGENT_CONCURRENCY_LIMIT_REACHED",
      statusCode: 429,
    });
  });

  // scheduled 配额按执行计数，同一持久实例上的第二个任务也不能绕过准入。
  test("scheduled execution limit applies to reused instances", () => {
    stubAgentRuntimeConfig({ scheduledAgentMaxConcurrency: 1 });
    const lease = acquireAgentExecution({ userId: "user-1", source: "scheduled" });
    lease.attach("shared-instance");
    try {
      expect(() => acquireAgentExecution({ userId: "user-1", source: "scheduled" })).toThrow();
      const interactive = acquireAgentExecution({ userId: "user-1", source: "interactive" });
      interactive.attach("shared-instance");
      interactive.release();
    } finally {
      lease.release();
    }
    const next = acquireAgentExecution({ userId: "user-1", source: "scheduled" });
    next.release();
  });
});
