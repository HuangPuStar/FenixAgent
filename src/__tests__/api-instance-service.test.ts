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
      spawnInstanceViaController: async () => {
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
      spawnInstanceViaController: async (...args) => {
        spawnCalls.push(args);
        return {
          instanceId: "inst-created",
        } as never;
      },
    });

    const result = await connectAgentInstance({ organizationId: "org-1", userId: "user-1", role: "owner" }, "agc-1");

    expect(result.instanceId).toBe("inst-created");
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toMatchObject(["env-created", "user-1", "interactive"]);
  });
});
