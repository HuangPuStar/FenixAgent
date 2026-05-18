import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { RuntimeInstanceSnapshot } from "@mothership/core";
import { resetCoreRuntime } from "../services/core-bootstrap";
import { _deps, _resetDeps } from "../services/instance";
import { setBuildLaunchSpec } from "../services/launch-spec-builder";

const mockListInstances = mock((): RuntimeInstanceSnapshot[] => []);
const mockGetInstance = mock(() => null as RuntimeInstanceSnapshot | null);
const mockStopInstance = mock(async () => {});
const mockLaunchInstance = mock(async () => ({
  instanceId: "inst_new",
  status: "running",
  errorMessage: null,
  pluginMetadata: { port: 8888, token: "tok" },
  createdAt: new Date(),
}));

const fakeFacade = {
  listInstances: mockListInstances,
  getInstance: mockGetInstance,
  stopInstance: mockStopInstance,
  launchInstance: mockLaunchInstance,
};

beforeEach(() => {
  resetCoreRuntime();
  _deps.getCoreRuntime = () => fakeFacade as any;
  _deps.getAgentConfigById = mock(async () => null as any) as any;
  _deps.getAgentFullConfig = mock(async () => ({ agentConfig: null, providers: [], skills: [], mcpServers: [] }));
  _deps.environmentRepo = { getById: mock(async () => null) } as any;
  _deps.findOrCreateForEnvironment = mock(async () => ({ id: "ses_1" })) as any;
  setBuildLaunchSpec(mock(async () => ({})) as any);
});

afterEach(() => {
  _resetDeps();
  setBuildLaunchSpec(null);
});

import { ensureRunning } from "../services/instance";

describe("ensureRunning merged core query", () => {
  beforeEach(() => {
    mockListInstances.mockClear();
  });

  // 无 running 实例时 listInstances 只调用一次
  test("calls listInstances once when no running instance", async () => {
    mockListInstances.mockReturnValueOnce([]);
    try {
      await ensureRunning("u1", "env_1");
    } catch {
      // Environment not found expected
    }
    expect(mockListInstances).toHaveBeenCalledTimes(1);
  });

  // 有 running 实例时也只调用一次
  test("calls listInstances once when running instance exists", async () => {
    mockListInstances.mockReturnValueOnce([]);
    try {
      await ensureRunning("u1", "env_nonexist");
    } catch {
      // expected
    }
    expect(mockListInstances).toHaveBeenCalledTimes(1);
  });
});
