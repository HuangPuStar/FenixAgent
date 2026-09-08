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
      listEnvironmentsByOrganizationId: async () => [],
      resolveInstance: async () => {
        throw new Error("not stubbed");
      },
      ensureInstanceRuntime: async () => {
        throw new Error("not stubbed");
      },
    });
  });

  afterEach(() => {
    setApiInstanceDeps(null);
  });

  // connectAgentInstance 必须先解析持久实例，再由 AgentInstanceService 启动 runtime。
  test("connectAgentInstance uses persistent instance service", async () => {
    const spawnCalls: unknown[] = [];
    setApiInstanceDeps({
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
      resolveInstance: async (input) => ({
        id: "inst-created",
        environmentId: input.environmentId,
        ownerUserId: input.ownerUserId,
        creationSource: "api",
        name: "primary",
        isDefault: false,
        createdByUserId: input.ownerUserId,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }),
      ensureInstanceRuntime: async (instance) => {
        spawnCalls.push(instance.id);
      },
    });

    const result = await connectAgentInstance({ organizationId: "org-1", userId: "user-1", role: "owner" }, "agc-1");

    expect(result.instanceId).toBe("inst-created");
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toBe("inst-created");
  });
});
