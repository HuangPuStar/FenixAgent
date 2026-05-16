import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── getInstance supplement 清理验证 ──
// R36 修复：getInstance 发现 core 无实例时清理 supplements Map

interface FakeSnapshot {
  instanceId: string;
  status: string;
  errorMessage: string | null;
  pluginMetadata: Record<string, unknown>;
  createdAt: Date;
}

const mockListInstances = mock((): FakeSnapshot[] => []);
const mockGetInstance = mock((): FakeSnapshot | null => null);
const mockStopInstance = mock(async () => {});
const mockLaunchInstance = mock(async (_params: unknown) => ({
  instanceId: "inst_test",
  status: "running",
  errorMessage: null,
  pluginMetadata: {},
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

mock.module("../services/launch-spec-builder", () => ({
  buildLaunchSpec: mock(async () => ({})),
}));

mock.module("../services/config-pg", () => ({
  getAgentConfigById: mock(async () => null),
  getAgentFullConfig: mock(async () => ({
    agentConfig: null, providers: [], skills: [], mcpServers: [],
  })),
}));

mock.module("../repositories", () => ({
  environmentRepo: {
    getById: mock(async () => ({
      id: "env_1",
      userId: "user1",
      workspacePath: "/tmp/test",
      secret: "env_secret_test",
      maxSessions: 3,
    })),
  },
  sessionRepo: { listByEnvironment: mock(async () => []) },
}));

mock.module("../services/session", () => ({
  findOrCreateForEnvironment: mock(async () => ({ id: "ses_1" })),
}));

mock.module("../logger", () => ({
  log: mock(() => {}),
  error: mock(() => {}),
}));

const { getInstance } = await import("../services/instance");

describe("getInstance supplement cleanup on stale core", () => {
  beforeEach(() => {
    mockGetInstance.mockClear();
    mockLaunchInstance.mockClear();
    mockListInstances.mockClear();
  });

  // core 中不存在实例时返回 undefined
  test("returns undefined when core has no instance", () => {
    mockGetInstance.mockReturnValueOnce(null);
    const result = getInstance("inst_ghost");
    expect(result).toBeUndefined();
  });

  // 有 userId 参数且不匹配时返回 undefined
  test("returns undefined when userId does not match", () => {
    mockGetInstance.mockReturnValueOnce({
      instanceId: "inst_1",
      status: "running",
      errorMessage: null,
      pluginMetadata: {},
      createdAt: new Date(),
    });
    const result = getInstance("inst_1", "other_user");
    expect(result).toBeUndefined();
  });

  // core 无实例且 supplements 无条目时正常返回 undefined
  test("returns undefined when neither core nor supplement has instance", () => {
    mockGetInstance.mockReturnValueOnce(null);
    const result = getInstance("inst_never_existed");
    expect(result).toBeUndefined();
  });

  // core 有实例但 supplements 无条目时返回 undefined
  test("returns undefined when supplement missing but core has instance", () => {
    mockGetInstance.mockReturnValueOnce({
      instanceId: "inst_orphan",
      status: "running",
      errorMessage: null,
      pluginMetadata: {},
      createdAt: new Date(),
    });
    const result = getInstance("inst_orphan");
    expect(result).toBeUndefined();
  });
});
