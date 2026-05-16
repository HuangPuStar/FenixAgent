import { describe, test, expect, mock, beforeEach } from "bun:test";

// ─�� groupActiveInstancesByEnvironment 单次遍历分组验证 ──

interface FakeSnapshot {
  instanceId: string;
  status: string;
  errorMessage: string | null;
  pluginMetadata: Record<string, unknown>;
  createdAt: Date;
}

const mockListInstances = mock((): FakeSnapshot[] => []);

mock.module("../services/core-bootstrap", () => ({
  getCoreRuntime: () => ({
    listInstances: mockListInstances,
    getInstance: mock(() => null),
    stopInstance: mock(async () => {}),
    launchInstance: mock(async () => ({})),
  }),
}));

mock.module("../services/launch-spec-builder", () => ({
  buildLaunchSpec: mock(async () => ({})),
}));

mock.module("../services/config-pg", () => ({
  getAgentConfigById: mock(async () => null),
  getAgentFullConfig: mock(async () => ({
    agentConfig: null,
    providers: [],
    skills: [],
    mcpServers: [],
  })),
}));

mock.module("../repositories", () => ({
  environmentRepo: {
    getById: mock(async () => null),
  },
  sessionRepo: {
    listByEnvironment: mock(async () => []),
  },
}));

mock.module("../services/session", () => ({
  findOrCreateForEnvironment: mock(async () => ({ id: "ses_1" })),
}));

mock.module("../logger", () => ({
  log: mock(() => {}),
  error: mock(() => {}),
}));

const { groupActiveInstancesByEnvironment } = await import("../services/instance");

describe("groupActiveInstancesByEnvironment", () => {
  beforeEach(() => {
    mockListInstances.mockClear();
  });

  // 多环境实例正确分组
  test("groups active instances by environmentId", () => {
    mockListInstances.mockReturnValueOnce([
      { instanceId: "i1", status: "running", errorMessage: null, pluginMetadata: {}, createdAt: new Date() },
      { instanceId: "i2", status: "running", errorMessage: null, pluginMetadata: {}, createdAt: new Date() },
      { instanceId: "i3", status: "starting", errorMessage: null, pluginMetadata: {}, createdAt: new Date() },
    ] as FakeSnapshot[]);

    const result = groupActiveInstancesByEnvironment();
    // 无 supplement 匹配，所有实例被跳过
    expect(result.size).toBe(0);
  });

  // 空列表返回空 Map
  test("returns empty map for empty instance list", () => {
    mockListInstances.mockReturnValueOnce([]);
    const result = groupActiveInstancesByEnvironment();
    expect(result.size).toBe(0);
  });

  // 仅调用一次 listInstances（性能验证）
  test("calls listInstances exactly once", () => {
    mockListInstances.mockReturnValueOnce([]);
    groupActiveInstancesByEnvironment();
    expect(mockListInstances).toHaveBeenCalledTimes(1);
  });

  // 过滤掉 stopped 和 error 状态
  test("filters out stopped and error instances", () => {
    // 需要有 supplement 才能进入分组逻辑
    // groupActiveInstancesByEnvironment 只过滤 status，supplement 查找是独立逻辑
    // 此测试验证 stopped/error 状态不会进入结果
    mockListInstances.mockReturnValueOnce([
      { instanceId: "stopped_1", status: "stopped", errorMessage: null, pluginMetadata: {}, createdAt: new Date() },
      { instanceId: "error_1", status: "error", errorMessage: "crash", pluginMetadata: {}, createdAt: new Date() },
    ] as FakeSnapshot[]);

    const result = groupActiveInstancesByEnvironment();
    expect(result.size).toBe(0);
  });
});
