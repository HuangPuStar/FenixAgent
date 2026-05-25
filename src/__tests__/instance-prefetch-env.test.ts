import { beforeEach, describe, expect, mock, test } from "bun:test";

const mockGetById = mock(() =>
  Promise.resolve({
    id: "env_test1",
    name: "test",
    description: null,
    workspacePath: "/tmp/test",
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
    organizationId: "test-team",
    autoStart: false,
    lastPollAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  }),
);

const fakeFacade = {
  launchInstance: mock(async () => ({
    instanceId: "inst_test",
    status: "running",
    createdAt: new Date(),
    errorMessage: null,
    pluginMetadata: {},
  })),
  listInstances: mock(() => []),
  getInstance: mock(() => undefined),
  stopInstance: mock(async () => {}),
};

mock.module("../services/core-bootstrap", () => ({
  getCoreRuntime: () => fakeFacade,
  resetCoreRuntime: () => {},
  setCoreRuntimeFactory: () => {},
}));

mock.module("../services/config-pg", () => ({
  getAgentConfigById: mock(async () => null as any),
  getAgentFullConfig: mock(async () => ({ agentConfig: null, providers: [], skills: [], mcpServers: [] })),
}));

mock.module("../repositories", () => ({
  environmentRepo: { getById: mockGetById },
}));

mock.module("../services/session", () => ({
  findOrCreateForEnvironment: mock(async () => ({ id: "ses_test" })),
}));

mock.module("../services/launch-spec-builder", () => ({
  buildLaunchSpec: mock(async () => ({})),
  setBuildLaunchSpec: () => {},
}));

import { spawnInstanceFromEnvironment } from "../services/instance";

const prefetchedEnv = {
  id: "env_test1",
  name: "test",
  description: null as string | null,
  workspacePath: "/tmp/test",
  agentConfigId: null as string | null,
  secret: "sec_test",
  machineName: null as string | null,
  directory: null as string | null,
  branch: null as string | null,
  gitRepoUrl: null as string | null,
  maxSessions: 1,
  workerType: "acp" as string | null,
  capabilities: null as Record<string, unknown> | null,
  status: "active" as string,
  username: null as string | null,
  userId: "user1",
  organizationId: "test-team",
  autoStart: false,
  lastPollAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("spawnInstanceFromEnvironment — prefetchedEnv 参数", () => {
  beforeEach(() => {
    mockGetById.mockClear();
  });

  // 提供 prefetchedEnv 时不再调用 environmentRepo.getById
  test("uses prefetchedEnv, skips DB fetch", async () => {
    const result = await spawnInstanceFromEnvironment("user1", "env_test1", prefetchedEnv as any);
    expect(mockGetById).not.toHaveBeenCalled();
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

  // 显式传入 undefined 等同于省略，走 getById 分支
  test("explicit undefined prefetchedEnv falls back to getById", async () => {
    await spawnInstanceFromEnvironment("user1", "env_test1", undefined);
    expect(mockGetById).toHaveBeenCalledTimes(1);
  });
});
