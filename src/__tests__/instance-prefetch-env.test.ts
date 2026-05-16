import { test, expect, mock, describe, beforeEach } from "bun:test";

// ── mock.module 必须在 import 被测模块之前注册 ──

const mockGetById = mock(() => Promise.resolve({
  id: "env_test1",
  name: "test",
  description: null,
  workspacePath: "/tmp/test",
  agentName: null,
  agentConfigId: null,
  secret: "sec_test",
  machineName: null,
  directory: null,
  branch: null,
  gitRepoUrl: null,
  maxSessions: 1,
  workerType: "acp",
  capabilities: null,
  status: "active",
  username: null,
  userId: "user1",
  autoStart: false,
  lastPollAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
}));

const mockListByUserId = mock(() => Promise.resolve([]));

mock.module("../repositories", () => ({
  environmentRepo: {
    getById: mockGetById,
    listByUserId: mockListByUserId,
  },
}));

const mockLaunchInstance = mock(() => Promise.resolve({
  instanceId: "inst_test",
  status: "running",
  createdAt: new Date(),
  errorMessage: null,
  pluginMetadata: {},
}));
const mockListInstances = mock(() => []);
const mockGetInstance = mock(() => undefined);

mock.module("../services/core-bootstrap", () => ({
  getCoreRuntime: () => ({
    launchInstance: mockLaunchInstance,
    listInstances: mockListInstances,
    getInstance: mockGetInstance,
  }),
}));

const mockBuildLaunchSpec = mock(() => Promise.resolve({}));
mock.module("../services/launch-spec-builder", () => ({
  buildLaunchSpec: mockBuildLaunchSpec,
}));

const mockGetAgentConfigById = mock(() => Promise.resolve(null));
const mockGetAgentFullConfig = mock(() => Promise.resolve({
  agentConfig: null,
  providers: [],
  skills: [],
  mcpServers: [],
}));
mock.module("../services/config-pg", () => ({
  getAgentConfigById: mockGetAgentConfigById,
  getAgentFullConfig: mockGetAgentFullConfig,
}));

mock.module("../services/session", () => ({
  findOrCreateForEnvironment: () => Promise.resolve({ id: "ses_test" }),
}));

mock.module("../logger", () => ({
  log: () => {},
  error: () => {},
}));

mock.module("../errors", () => {
  class AppError extends Error {
    code: string;
    statusCode: number;
    constructor(message: string, code: string, statusCode: number = 500) {
      super(message);
      this.name = "AppError";
      this.code = code;
      this.statusCode = statusCode;
    }
  }
  class NotFoundError extends AppError {
    constructor(message: string) {
      super(message, "NOT_FOUND", 404);
      this.name = "NotFoundError";
    }
  }
  return { AppError, NotFoundError };
});

// import after mocks
import { spawnInstanceFromEnvironment } from "../services/instance";

// 共用的 prefetchedEnv 数据
const prefetchedEnv = {
  id: "env_test1",
  name: "test",
  description: null,
  workspacePath: "/tmp/test",
  agentName: null,
  agentConfigId: null,
  secret: "sec_test",
  machineName: null,
  directory: null,
  branch: null,
  gitRepoUrl: null,
  maxSessions: 1,
  workerType: "acp",
  capabilities: null as Record<string, unknown> | null,
  status: "active",
  username: null,
  userId: "user1",
  autoStart: false,
  lastPollAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("spawnInstanceFromEnvironment — prefetchedEnv 参数", () => {
  beforeEach(() => {
    mockGetById.mockClear();
    mockLaunchInstance.mockClear();
    mockBuildLaunchSpec.mockClear();
    mockGetAgentConfigById.mockClear();
    mockGetAgentFullConfig.mockClear();
  });

  // 提供 prefetchedEnv 时不再调用 environmentRepo.getById
  test("uses prefetchedEnv, skips DB fetch", async () => {
    const result = await spawnInstanceFromEnvironment("user1", "env_test1", prefetchedEnv);
    expect(mockGetById).not.toHaveBeenCalled();
    // 确认函数正常返回了 SpawnedInstance
    expect(result).toBeDefined();
    expect(result.id).toBe("inst_test");
    expect(result.userId).toBe("user1");
    expect(result.environmentId).toBe("env_test1");
  });

  // 不传 prefetchedEnv 时会调用 getById 回退到数据库查询
  test("falls back to getById when prefetchedEnv omitted", async () => {
    await spawnInstanceFromEnvironment("user1", "env_test1");
    expect(mockGetById).toHaveBeenCalledTimes(1);
    expect(mockGetById).toHaveBeenCalledWith("env_test1");
  });

  // prefetchedEnv 的 userId 不匹配时抛出 FORBIDDEN
  test("throws FORBIDDEN when userId mismatch", async () => {
    const wrongUserEnv = { ...prefetchedEnv, userId: "user_other" };
    try {
      await spawnInstanceFromEnvironment("user1", "env_test1", wrongUserEnv);
      expect.unreachable("should have thrown");
    } catch (err: unknown) {
      expect((err as { code: string }).code).toBe("FORBIDDEN");
    }
  });

  // 显式传入 undefined 等同于省略，走 getById 分支
  test("explicit undefined prefetchedEnv falls back to getById", async () => {
    await spawnInstanceFromEnvironment("user1", "env_test1", undefined);
    expect(mockGetById).toHaveBeenCalledTimes(1);
  });
});
