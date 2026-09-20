import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import { initializeAgentRuntimeModuleConfig, stubAgentRuntimeConfig } from "../server/testing";
import { resetAgentConcurrencyDeps, setAgentConcurrencyDeps } from "../services/agent-concurrency";
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

  // scheduled 并发超限时只拒绝 scheduled 启动
  test("spawnInstanceViaController rejects when scheduled concurrency limit is reached", async () => {
    stubAgentRuntimeConfig({
      agentMaxConcurrency: 10,
      scheduledAgentMaxConcurrency: 1,
    });
    globalInstanceRegistry.register("inst_1", {
      userId: "user-1",
      environmentId: "env-1",
      organizationId: "org-1",
      spawnSource: "scheduled",
      lastActivityAt: Date.now(),
      relayCount: 0,
      lastRelayDetachedAt: Date.now(),
    });
    setAgentConcurrencyDeps({
      getRuntime: () => makeRuntime(["running"]) as never,
    });

    await expect(
      spawnInstanceViaController("env-2", "user-1", "scheduled", { instanceUid: "inst_test_scheduled" }),
    ).rejects.toMatchObject({
      code: "SCHEDULED_AGENT_CONCURRENCY_LIMIT_REACHED",
      statusCode: 429,
    });
  });
});
