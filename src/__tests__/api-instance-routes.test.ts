import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { setApiInstanceDeps } from "../services/api-instance";
import { setTestOrgContext } from "../services/org-context";

const apiInstanceRoute = (await import("../routes/api/instances")).default;
const testConnectRoute = test.skipIf(process.env.RUN_SKIP_TEST !== "1");

function request(path: string, init?: RequestInit) {
  return apiInstanceRoute.handle(new Request(`http://localhost${path}`, init));
}

describe("API Instance Routes", () => {
  beforeEach(() => {
    setTestAuth({
      user: { id: "user-1", email: "user@test.com", name: "Tester" },
      authContext: { organizationId: "org-1", userId: "user-1", role: "owner" },
    });
    setTestOrgContext({ organizationId: "org-1", userId: "user-1", role: "owner" });
    setApiInstanceDeps({
      listEnvironmentsByOrganizationId: async () => [],
      groupActiveInstancesByEnvironment: () => new Map(),
      getReadableAgentConfigById: async () => null,
      createWebEnvironment: async () => {
        throw new Error("not stubbed");
      },
      getRunningInstancesByEnvironment: () => [],
      spawnInstanceFromEnvironment: async () => {
        throw new Error("not stubbed");
      },
    });
  });

  afterEach(() => {
    setApiInstanceDeps(null);
    resetTestAuth();
    setTestOrgContext(null);
  });

  // connect 接口应支持外部共享 Agent，并为当前用户创建独立 runtime environment。
  testConnectRoute(
    "POST /api/agents/:agentConfigId/instances/connect creates user runtime for shared agent",
    async () => {
      setApiInstanceDeps({
        getReadableAgentConfigById: async () =>
          ({
            id: "agc-demo",
            organizationId: "org-2",
            userId: "user-2",
            name: "Demo Agent",
            description: "demo",
            prompt: null,
            modelId: null,
            model: null,
            machineId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            extra: null,
          }) as never,
        listEnvironmentsByOrganizationId: async () => [],
        createWebEnvironment: async () =>
          ({
            id: "env-created",
            name: "runtime-demo-agent-agc-demo",
            description: "demo",
            agentConfigId: "agc-demo",
            organizationId: "org-1",
            userId: "user-1",
            status: "active",
          }) as never,
        getRunningInstancesByEnvironment: () => [],
        spawnInstanceFromEnvironment: async () =>
          ({
            id: "inst-created",
            environmentId: "env-created",
            status: "running",
          }) as never,
      });

      const res = await request("/api/agents/agc-demo/instances/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json).toEqual({
        agentConfigId: "agc-demo",
        environmentId: "env-created",
        instanceId: "inst-created",
        relay: {
          wsUrl: "/acp/relay/env-created",
        },
      });
    },
  );
});
