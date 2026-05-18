import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { RuntimeInstanceSnapshot } from "@mothership/core";
import { resetCoreRuntime } from "../services/core-bootstrap";
import { _deps, _resetDeps } from "../services/instance";
import { setBuildLaunchSpec } from "../services/launch-spec-builder";

const mockListInstances = mock((): RuntimeInstanceSnapshot[] => []);
const mockLaunchInstance = mock(async (params: any) => ({
  instanceId: params.instanceId,
  status: "running",
  errorMessage: null,
  pluginMetadata: { port: 8080, token: "test", pid: 123 },
  createdAt: new Date(),
}));

const fakeFacade = {
  listInstances: mockListInstances,
  getInstance: mock(() => null),
  stopInstance: mock(async () => {}),
  launchInstance: mockLaunchInstance,
};

beforeEach(() => {
  resetCoreRuntime();
  _deps.getCoreRuntime = () => fakeFacade as any;
  _deps.getAgentConfigById = mock(async () => null as any) as any;
  _deps.getAgentFullConfig = mock(async () => ({ agentConfig: null, providers: [], skills: [], mcpServers: [] }));
  _deps.environmentRepo = {
    getById: mock(async () => ({
      id: "env_1",
      userId: "user1",
      teamId: "user1",
      workspacePath: "/tmp/test",
      secret: "env_secret_test",
      maxSessions: 2,
    })),
  } as any;
  _deps.findOrCreateForEnvironment = mock(async () => ({ id: "ses_1" })) as any;
  setBuildLaunchSpec(mock(async () => ({})) as any);
});

afterEach(() => {
  _resetDeps();
  setBuildLaunchSpec(null);
});

import { ensureRunning } from "../services/instance";

describe("ensureRunning re-check after async gap", () => {
  beforeEach(() => {
    mockListInstances.mockClear();
    mockLaunchInstance.mockClear();
  });

  // 初始无实例 + async gap 后仍无实例 → spawn（listInstances 被调用 2 次）
  test("calls listInstances twice: before and after async gap", async () => {
    mockListInstances.mockReturnValue([]);
    const result = await ensureRunning("user1", "env_1");
    expect(result.status).toBe("spawned");
    expect(mockListInstances).toHaveBeenCalledTimes(2);
    expect(mockLaunchInstance).toHaveBeenCalledTimes(1);
  });

  // spawn 成功后返回 spawned 状态
  test("returns spawned status on successful launch", async () => {
    mockListInstances.mockReturnValue([]);
    const result = await ensureRunning("user1", "env_1");
    expect(result.status).toBe("spawned");
    expect(result.instance).toBeDefined();
    expect(result.instance.status).toBe("running");
  });
});
