import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConcurrencyExceededError } from "@fenix/orchestration";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { setApiInstanceDeps } from "../services/api-instance";
import { setTestOrgContext } from "../services/org-context";
import { resetAllStubs, stubCoreBootstrap } from "../test-utils/helpers";

const apiInstanceRoute = (await import("../routes/api/instances")).default;

function request(path: string, init?: RequestInit) {
  return apiInstanceRoute.handle(new Request(`http://localhost${path}`, init));
}

describe("API Instance Routes", () => {
  beforeEach(() => {
    resetAllStubs();
    // getRunningInstancesByEnvironment 依赖 core runtime 的实例快照；
    // core-bootstrap 已在 setup-mocks.ts 中 preload mock，这里提供可控的空快照
    stubCoreBootstrap({
      getCoreRuntime: () => ({ listInstances: () => [] }),
    });
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
      spawnInstanceViaController: async () => {
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
  test("POST /api/agents/:agentId/instances/connect creates user runtime for shared agent", async () => {
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
      spawnInstanceViaController: async () =>
        ({
          instanceId: "inst-created",
          environmentId: "env-created",
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
        // D-P1.1：wsUrl 附带 instanceId query，供多实例环境下 relay 端点精确连接
        wsUrl: "/acp/relay/env-created?instanceId=inst-created",
      },
    });
  });

  // D-P2.2：OrchestrationError（无 statusCode 字段）不再被 mapApiError 兜底降级
  // 500，按编排域映射返回 409，且 message 脱敏（ConcurrencyExceededError 实际
  // 抛出时拼接 envId，属内部资源标识）
  test("spawnInstanceViaController 抛 ConcurrencyExceededError 返回 409 且 message 脱敏", async () => {
    setApiInstanceDeps({
      getReadableAgentConfigById: async () =>
        ({ id: "agc-demo", organizationId: "org-1", userId: "user-1", name: "Demo Agent" }) as never,
      listEnvironmentsByOrganizationId: async () => [],
      createWebEnvironment: async () =>
        ({
          id: "env-1",
          name: "runtime-demo",
          description: null,
          agentConfigId: "agc-demo",
          organizationId: "org-1",
          userId: "user-1",
          status: "active",
        }) as never,
      getRunningInstancesByEnvironment: () => [],
      spawnInstanceViaController: async () => {
        throw new ConcurrencyExceededError("Environment 'env_x' reached max concurrency (1)");
      },
    });

    const res = await request("/api/agents/agc-demo/instances/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error.code).toBe("CONCURRENCY_EXCEEDED");
    expect(json.error.message).toBe("Concurrency limit exceeded");
    expect(JSON.stringify(json)).not.toContain("env_x");
  });

  // D-P2.2：未知错误（如 CoreRuntimeError 500）兜底 message 固定通用文案，
  // 不再拼接 error.message（可能携带 machineId，属泄漏口）
  test("spawnInstanceViaController 抛普通 Error 返回 500 INTERNAL_ERROR 且 message 脱敏", async () => {
    setApiInstanceDeps({
      getReadableAgentConfigById: async () =>
        ({ id: "agc-demo", organizationId: "org-1", userId: "user-1", name: "Demo Agent" }) as never,
      listEnvironmentsByOrganizationId: async () => [],
      createWebEnvironment: async () =>
        ({
          id: "env-1",
          name: "runtime-demo",
          description: null,
          agentConfigId: "agc-demo",
          organizationId: "org-1",
          userId: "user-1",
          status: "active",
        }) as never,
      getRunningInstancesByEnvironment: () => [],
      spawnInstanceViaController: async () => {
        throw new Error("Core node is offline: machine-42");
      },
    });

    const res = await request("/api/agents/agc-demo/instances/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error.code).toBe("INTERNAL_ERROR");
    expect(json.error.message).toBe("Internal server error");
    expect(JSON.stringify(json)).not.toContain("machine-42");
  });
});
