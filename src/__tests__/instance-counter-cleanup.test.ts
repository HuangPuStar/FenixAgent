// 测试 stopInstance 清理 envInstanceCounters：无活跃实例时释放 Map 条目
import { describe, test, expect, mock } from "bun:test";

// mock core-bootstrap
const mockListInstances = mock(() => []);
const mockGetInstance = mock(() => undefined);
const mockStopInstance = mock(async () => {});
const mockLaunchInstance = mock(async (spec: any) => ({
  instanceId: spec.instanceId,
  status: "running",
  pluginMetadata: {},
  errorMessage: null,
  createdAt: new Date(),
}));

mock.module("../services/core-bootstrap", () => ({
  getCoreRuntime: () => ({
    listInstances: mockListInstances,
    getInstance: mockGetInstance,
    stopInstance: mockStopInstance,
    launchInstance: mockLaunchInstance,
  }),
}));

mock.module("../services/config-pg", () => ({
  getAgentConfigById: mock(async () => null),
  getAgentFullConfig: mock(async () => ({ agentConfig: null, providers: [], skills: [], mcpServers: [] })),
}));

mock.module("../services/session", () => ({
  findOrCreateForEnvironment: mock(async () => ({ id: "ses_1" })),
}));

mock.module("../services/launch-spec-builder", () => ({
  buildLaunchSpec: mock(async () => ({})),
}));

mock.module("../repositories", () => ({
  environmentRepo: { getById: mock(async () => ({ id: "env_1", userId: "u1", secret: "s1", maxSessions: 5, workspacePath: "/tmp/ws1" })) },
}));

const {
  stopInstance,
  spawnInstanceFromEnvironment,
  getRunningInstancesByEnvironment,
  listInstancesByEnvironment,
} = await import("../services/instance");

describe("stopInstance envInstanceCounters cleanup", () => {
  test("clears counter when last instance stopped", async () => {
    // spawn 一个实例
    const spawnedId = `inst_${"a".repeat(16)}`;
    const snap = {
      instanceId: spawnedId,
      status: "running",
      pluginMetadata: { port: 8888, pid: 1234, token: "abc" },
      errorMessage: null,
      createdAt: new Date(),
    };

    mockLaunchInstance.mockImplementation(async (spec: any) => ({
      instanceId: spec.instanceId,
      status: "running",
      pluginMetadata: { port: 8888, pid: 1234, token: "abc" },
      errorMessage: null,
      createdAt: new Date(),
    }));
    mockListInstances.mockImplementation(() => []);
    mockGetInstance.mockImplementation(() => undefined);

    // spawn — 之后 listInstances 应返回 spawned snapshot
    mockLaunchInstance.mockImplementation(async (spec: any) => {
      const s = {
        instanceId: spec.instanceId,
        status: "running",
        pluginMetadata: { port: 8888, pid: 1234, token: "abc" },
        errorMessage: null,
        createdAt: new Date(),
      };
      // spawn 后让 list/get 返回该 snapshot
      mockListInstances.mockImplementation(() => [s]);
      mockGetInstance.mockImplementation((id: string) =>
        id === spec.instanceId ? s : undefined,
      );
      return s;
    });

    const inst = await spawnInstanceFromEnvironment("u1", "env_1");
    expect(inst.id).toBeTruthy();

    // 确认实例 running
    const before = getRunningInstancesByEnvironment("env_1");
    expect(before.length).toBe(1);

    // 停止该实例
    const currentId = inst.id;
    mockStopInstance.mockImplementation(async () => {
      mockListInstances.mockImplementation(() => []);
      mockGetInstance.mockImplementation(() => undefined);
    });

    const result = await stopInstance(currentId, "u1");
    expect(result.ok).toBe(true);

    // 停止后无活跃实例（envInstanceCounters 已清理）
    const after = getRunningInstancesByEnvironment("env_1");
    expect(after.length).toBe(0);
  });

  test("preserves counter when other instances remain", async () => {
    // spawn 两个实例
    const snapshots: any[] = [];

    mockLaunchInstance.mockImplementation(async (spec: any) => {
      const s = {
        instanceId: spec.instanceId,
        status: "running",
        pluginMetadata: { port: 8888 + snapshots.length, pid: 100 + snapshots.length, token: `tok${snapshots.length}` },
        errorMessage: null,
        createdAt: new Date(),
      };
      snapshots.push(s);
      mockListInstances.mockImplementation(() => [...snapshots]);
      mockGetInstance.mockImplementation((id: string) =>
        snapshots.find((s) => s.instanceId === id),
      );
      return s;
    });

    const inst1 = await spawnInstanceFromEnvironment("u1", "env_1");
    const inst2 = await spawnInstanceFromEnvironment("u1", "env_1");

    const before = getRunningInstancesByEnvironment("env_1");
    expect(before.length).toBe(2);

    // 停止第一个实例（第二个仍在）
    mockStopInstance.mockImplementation(async (id: string) => {
      const idx = snapshots.findIndex((s) => s.instanceId === id);
      if (idx >= 0) snapshots.splice(idx, 1);
      mockListInstances.mockImplementation(() => [...snapshots]);
      mockGetInstance.mockImplementation((checkId: string) =>
        snapshots.find((s) => s.instanceId === checkId),
      );
    });

    const result = await stopInstance(inst1.id, "u1");
    expect(result.ok).toBe(true);

    // 第二个实例仍在
    const remaining = getRunningInstancesByEnvironment("env_1");
    expect(remaining.length).toBe(1);
    expect(remaining[0].id).toBe(inst2.id);
  });
});
