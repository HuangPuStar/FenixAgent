import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { RuntimeInstanceSnapshot } from "@mothership/core";

// ────────────────────────────────────────────
// Mock 依赖 — mock.module 必须在 import 被测模块之前
// ────────────────────────────────────────────

const mockLaunchInstance = mock(
  async (req: { instanceId: string; engineType: string; nodeId: string; launchSpec: unknown }) => ({
    instanceId: req.instanceId,
    engineType: "opencode",
    nodeId: "local-default",
    status: "running" as const,
    launchSpec: req.launchSpec,
    relayConnected: false,
    errorMessage: undefined,
    pluginMetadata: {
      port: 8888,
      token: "test_token_acquired_from_runtime",
      pid: 12345,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  }),
);

const mockStopInstance = mock(async (_id: string) => {});
const mockListInstances = mock((): RuntimeInstanceSnapshot[] => []);
const mockGetInstance = mock((_id: string): RuntimeInstanceSnapshot | null => null);

const fakeFacade = {
  launchInstance: mockLaunchInstance,
  stopInstance: mockStopInstance,
  listInstances: mockListInstances,
  getInstance: mockGetInstance,
  getPlugin: () => null,
  registerPlugin: () => {},
  registerNode: () => {},
  connectInstanceRelay: mock(async () => ({})),
  getNode: () => null,
  listNodes: () => [],
  listPlugins: () => [],
};

mock.module("../services/core-bootstrap", () => ({
  getCoreRuntime: () => fakeFacade as any,
  resetCoreRuntime: () => {},
  setCoreRuntimeFactory: () => {},
}));

mock.module("../services/config-pg", () => ({
  getAgentConfigById: mock(async (id: string) => ({ name: "test-agent", id })),
  getAgentFullConfig: mock(async () => ({
    agentConfig: { name: "test-agent", model: "openai/gpt-4", prompt: "test" },
    providers: [{ name: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "sk-test", npm: "@ai-sdk/openai" }],
    skills: [],
    mcpServers: [],
  })),
}));

mock.module("../services/launch-spec-builder", () => ({
  buildLaunchSpec: mock(async () => ({
    workspace: "/tmp/test-workspace",
    agent: { name: "test-agent" },
    model: {
      provider: "openai",
      protocol: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      model: "gpt-4",
    },
    skills: [],
    mcpServers: [],
  })),
  setBuildLaunchSpec: () => {},
}));

// envId → userId 映射
const envOwnerMap = new Map<string, string>();

mock.module("../repositories", () => ({
  environmentRepo: {
    getById: mock(async (id: string) => ({
      id,
      userId: envOwnerMap.get(id) ?? "test-user",
      agentConfigId: null,
      name: "test-env",
      workspacePath: "/tmp/test-workspace",
      directory: "/tmp/test-workspace",
      secret: "env_secret_test123",
      maxSessions: 5,
      status: "active",
      organizationId: "team-test",
    })),
    update: mock(async () => true),
    create: mock(async (params: any) => ({
      id: `env_${Date.now()}`,
      ...params,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
    listActive: mock(async () => []),
    listAll: mock(async () => []),
    listByUserId: mock(async () => []),
  },
}));

mock.module("../services/session", () => ({
  findOrCreateForEnvironment: mock(async () => ({ id: "session_test" })),
}));

beforeEach(() => {
  mockLaunchInstance.mockClear();
  mockStopInstance.mockClear();
  mockListInstances.mockClear();
  mockGetInstance.mockClear();
  envOwnerMap.clear();
});

// ────────────────────────────────────────────
// 导入被测模块（无 mock.module，直接导入）
// ────────────────────────────────────────────

function mockSnapshot(overrides: Partial<RuntimeInstanceSnapshot> & { instanceId: string }): RuntimeInstanceSnapshot {
  return {
    engineType: "opencode",
    nodeId: "local-default",
    status: "running",
    launchSpec: {
      workspace: "/tmp",
      agent: { name: "test" },
      model: { provider: "openai", protocol: "openai", baseUrl: "", apiKey: "", model: "gpt-4" },
      skills: [],
      mcpServers: [],
    } as any,
    relayConnected: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

import {
  ensureRunning,
  findRunningInstanceByEnvironment,
  getInstance,
  getRunningInstancesByEnvironment,
  listInstances,
  listInstancesByEnvironment,
  spawnInstanceFromEnvironment,
  stopInstance,
} from "../services/instance";

/** 注册 envId→userId 映射并执行 spawn */
async function spawnForUser(userId: string, envId: string) {
  envOwnerMap.set(envId, userId);
  return spawnInstanceFromEnvironment(userId, envId);
}

describe("CoreInstanceAdapter — spawn", () => {
  const createdInstanceIds: string[] = [];

  afterEach(async () => {
    for (const id of createdInstanceIds) {
      try {
        await stopInstance(id, "test-user");
      } catch {}
    }
    createdInstanceIds.length = 0;
  });

  // spawnInstanceFromEnvironment 委托给 core.launchInstance
  test("spawnInstanceFromEnvironment 委托给 core.launchInstance", async () => {
    const inst = await spawnForUser("test-user", "env_test");

    expect(mockLaunchInstance).toHaveBeenCalledTimes(1);
    const call = mockLaunchInstance.mock.calls[0][0];
    expect(call.engineType).toBe("opencode");
    expect(call.nodeId).toBe("local-default");
    expect(call.instanceId).toMatch(/^inst_/);

    expect(inst.id).toMatch(/^inst_/);
    expect(inst.port).toBe(8888);
    expect(inst.apiKey).toBe("test_token_acquired_from_runtime");
    expect(inst.pid).toBe(12345);
    expect(inst.status).toBe("running");
    expect(inst.environmentId).toBe("env_test");
    expect(inst.userId).toBe("test-user");
    expect(inst.instanceNumber).toBe(1);

    createdInstanceIds.push(inst.id);
  });

  // 实例编号递增
  test("instance numbers 严格递增", async () => {
    const inst1 = await spawnForUser("test-user", "env_nums");
    const inst2 = await spawnForUser("test-user", "env_nums");
    const inst3 = await spawnForUser("test-user", "env_nums");

    expect(inst1.instanceNumber).toBe(1);
    expect(inst2.instanceNumber).toBe(2);
    expect(inst3.instanceNumber).toBe(3);

    createdInstanceIds.push(inst1.id, inst2.id, inst3.id);
  });
});

describe("CoreInstanceAdapter — query", () => {
  // listInstances 按 teamId 过滤
  test("listInstances 按 teamId 过滤", async () => {
    const inst1 = await spawnForUser("user-a", "env_list_a");
    const inst2 = await spawnForUser("user-b", "env_list_b");

    mockListInstances.mockReturnValueOnce([
      mockSnapshot({ instanceId: inst1.id, pluginMetadata: { port: 8888, token: "t", pid: 1 } }),
      mockSnapshot({ instanceId: inst2.id, pluginMetadata: { port: 8889, token: "t2", pid: 2 } }),
    ]);

    const teamTest = listInstances("team-test");
    expect(teamTest).toHaveLength(2);

    mockListInstances.mockReturnValueOnce([
      mockSnapshot({ instanceId: inst1.id, pluginMetadata: { port: 8888, token: "t", pid: 1 } }),
      mockSnapshot({ instanceId: inst2.id, pluginMetadata: { port: 8889, token: "t2", pid: 2 } }),
    ]);

    const otherTeam = listInstances("other-team");
    expect(otherTeam).toHaveLength(0);
  });

  // findRunningInstanceByEnvironment 按 environmentId 过滤
  test("findRunningInstanceByEnvironment 找到匹配的 running 实例", async () => {
    const inst = await spawnForUser("test-user", "env_find");

    mockListInstances.mockReturnValueOnce([
      mockSnapshot({ instanceId: inst.id, pluginMetadata: { port: 8888, token: "t", pid: 1 } }),
    ]);

    const found = findRunningInstanceByEnvironment("env_find");
    expect(found).toBeDefined();
    expect(found!.id).toBe(inst.id);
    expect(found!.environmentId).toBe("env_find");
  });

  // findRunningInstanceByEnvironment 找不到时不返回
  test("findRunningInstanceByEnvironment 未匹配时返回 undefined", async () => {
    await spawnForUser("test-user", "env_find_miss");

    mockListInstances.mockReturnValueOnce([mockSnapshot({ instanceId: "inst_no_match" })]);

    const found = findRunningInstanceByEnvironment("env_nonexistent");
    expect(found).toBeUndefined();
  });

  // getInstance 返回已创建的实例
  test("getInstance 返回已有实例", async () => {
    const inst = await spawnForUser("test-user", "env_get");

    mockGetInstance.mockReturnValueOnce(
      mockSnapshot({ instanceId: inst.id, pluginMetadata: { port: 8888, token: "t", pid: 1 } }),
    );

    const found = getInstance(inst.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(inst.id);
  });

  // getInstance 返回 undefined
  test("getInstance 不存在时返回 undefined", () => {
    mockGetInstance.mockReturnValueOnce(null);
    expect(getInstance("inst_nonexistent")).toBeUndefined();
  });

  // listInstancesByEnvironment 只返回活跃实例
  test("listInstancesByEnvironment 过滤 stopped 实例", async () => {
    const inst = await spawnForUser("test-user", "env_list_by_env");

    mockListInstances.mockReturnValueOnce([mockSnapshot({ instanceId: inst.id, status: "stopped" })]);

    const active = listInstancesByEnvironment("env_list_by_env");
    expect(active).toHaveLength(0);
  });

  // getRunningInstancesByEnvironment 只返回 running 实例
  test("getRunningInstancesByEnvironment 只返回 running", async () => {
    const inst = await spawnForUser("test-user", "env_running");

    mockListInstances.mockReturnValueOnce([
      mockSnapshot({ instanceId: inst.id, pluginMetadata: { port: 8888, token: "t", pid: 1 } }),
    ]);

    const running = getRunningInstancesByEnvironment("env_running");
    expect(running).toHaveLength(1);
    expect(running[0].status).toBe("running");
  });
});

describe("CoreInstanceAdapter — stop", () => {
  // stopInstance 成功
  test("stopInstance 委托给 core.stopInstance", async () => {
    const inst = await spawnForUser("test-user", "env_stop");

    mockGetInstance.mockReturnValueOnce(mockSnapshot({ instanceId: inst.id }));

    const result = await stopInstance(inst.id, "team-test");
    expect(result.ok).toBe(true);
    expect(mockStopInstance).toHaveBeenCalledTimes(1);
  });

  // stopInstance 拒绝非 owner
  test("stopInstance 拒绝非 owner", async () => {
    const inst = await spawnForUser("owner-user", "env_owner_stop");

    const result = await stopInstance(inst.id, "wrong-team");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Not your instance");
  });

  // stopInstance 不存在
  test("stopInstance 不存在时返回错误", async () => {
    const result = await stopInstance("inst_nonexistent", "team-test");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Instance not found");
  });

  // stopInstance 已停止
  test("stopInstance 已停止实例", async () => {
    const inst = await spawnForUser("test-user", "env_already_stopped");

    mockGetInstance.mockReturnValueOnce(mockSnapshot({ instanceId: inst.id, status: "stopped" }));

    const result = await stopInstance(inst.id, "team-test");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Already stopped");
  });
});

describe("CoreInstanceAdapter — ensureRunning", () => {
  // 复用已有 running 实例
  test("ensureRunning 复用已有 running 实例", async () => {
    const inst = await spawnForUser("test-user", "env_ensure");

    mockLaunchInstance.mockClear();

    mockListInstances.mockReturnValueOnce([
      mockSnapshot({ instanceId: inst.id, pluginMetadata: { port: 8888, token: "t", pid: 1 } }),
    ]);

    const result = await ensureRunning("test-user", "env_ensure");
    expect(result.status).toBe("reused");
    expect(result.instance.id).toBe(inst.id);
    expect(mockLaunchInstance).not.toHaveBeenCalled();
  });

  // 创建新实例
  test("ensureRunning 创建新实例", async () => {
    mockListInstances.mockReturnValueOnce([]);

    const result = await ensureRunning("test-user", "env_ensure_new");
    expect(result.status).toBe("spawned");
    expect(result.instance.id).toMatch(/^inst_/);
  });
});
