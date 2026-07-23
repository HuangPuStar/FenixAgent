import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { config, setConfig } from "../config";
import { resetAgentConcurrencyDeps, setAgentConcurrencyDeps } from "../services/agent-concurrency";
import { spawnInstanceFromEnvironment } from "../services/instance";
import { globalInstanceRegistry } from "../services/instance-registry";

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
  const originalConfig = { ...config };

  beforeEach(() => {
    globalInstanceRegistry.clear();
    resetAgentConcurrencyDeps();
    setConfig({
      ...originalConfig,
      agentMaxConcurrency: undefined,
      scheduledAgentMaxConcurrency: undefined,
    });
  });

  afterEach(() => {
    globalInstanceRegistry.clear();
    resetAgentConcurrencyDeps();
    setConfig(originalConfig);
  });

  // 总并发超限时应在真正查环境前直接拒绝
  test("spawnInstanceFromEnvironment rejects when total concurrency limit is reached", async () => {
    setConfig({ ...originalConfig, agentMaxConcurrency: 1 });
    setAgentConcurrencyDeps({
      getRuntime: () => makeRuntime(["running"]) as never,
    });

    await expect(
      spawnInstanceFromEnvironment("user-1", "env-1", undefined, { source: "interactive" }),
    ).rejects.toMatchObject({
      code: "AGENT_CONCURRENCY_LIMIT_REACHED",
      statusCode: 429,
    });
  });

  // scheduled 并发超限时只拒绝 scheduled 启动
  test("spawnInstanceFromEnvironment rejects when scheduled concurrency limit is reached", async () => {
    setConfig({
      ...originalConfig,
      agentMaxConcurrency: 10,
      scheduledAgentMaxConcurrency: 1,
    });
    globalInstanceRegistry.register("inst_1", {
      userId: "user-1",
      environmentId: "env-1",
      instanceNumber: 1,
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
      spawnInstanceFromEnvironment("user-1", "env-2", undefined, { source: "scheduled" }),
    ).rejects.toMatchObject({
      code: "SCHEDULED_AGENT_CONCURRENCY_LIMIT_REACHED",
      statusCode: 429,
    });
  });
});
