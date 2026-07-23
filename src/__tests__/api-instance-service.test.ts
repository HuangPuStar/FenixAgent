import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { connectAgentInstance, setApiInstanceDeps } from "../services/api-instance";

describe("api instance service", () => {
  beforeEach(() => {
    setApiInstanceDeps({
      createWebEnvironment: async () => {
        throw new Error("not stubbed");
      },
      getReadableAgentConfigById: async () => {
        throw new Error("not stubbed");
      },
      getRunningInstancesByEnvironment: () => [],
      groupActiveInstancesByEnvironment: () => new Map(),
      listEnvironmentsByOrganizationId: async () => [],
      spawnInstanceFromEnvironment: async () => {
        throw new Error("not stubbed");
      },
    });
  });

  afterEach(() => {
    setApiInstanceDeps(null);
  });

  // connectAgentInstance 启新实例时应显式标记为 interactive
  test("connectAgentInstance forwards interactive source when spawning", async () => {
    const spawnCalls: unknown[] = [];
    setApiInstanceDeps({
      getRunningInstancesByEnvironment: () => [],
      groupActiveInstancesByEnvironment: () => new Map(),
      listEnvironmentsByOrganizationId: async () => [],
      getReadableAgentConfigById: async () =>
        ({
          id: "agc-1",
          name: "Demo Agent",
          description: "demo",
        }) as never,
      createWebEnvironment: async () =>
        ({
          id: "env-created",
          userId: "user-1",
          organizationId: "org-1",
          agentConfigId: "agc-1",
        }) as never,
      spawnInstanceFromEnvironment: async (...args) => {
        spawnCalls.push(args);
        return {
          id: "inst-created",
          userId: "user-1",
          port: 0,
          pid: null,
          status: "running",
          command: "",
          error: null,
          apiKey: "",
          createdAt: new Date("2026-07-23T00:00:00Z"),
          environmentId: "env-created",
          instanceNumber: 1,
        };
      },
    });

    const result = await connectAgentInstance({ organizationId: "org-1", userId: "user-1", role: "owner" }, "agc-1");

    expect(result.instanceId).toBe("inst-created");
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toMatchObject(["user-1", "env-created", expect.anything(), { source: "interactive" }]);
  });
});
