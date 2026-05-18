import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { RuntimeInstanceSnapshot } from "@mothership/core";
import { resetCoreRuntime } from "../services/core-bootstrap";
import { _deps, _resetDeps } from "../services/instance";
import { setBuildLaunchSpec } from "../services/launch-spec-builder";

const mockListInstances = mock((): RuntimeInstanceSnapshot[] => []);
const mockGetInstance = mock((): RuntimeInstanceSnapshot | null => null);
const mockStopInstance = mock(async () => {});

const fakeFacade = {
  listInstances: mockListInstances,
  getInstance: mockGetInstance,
  stopInstance: mockStopInstance,
  launchInstance: mock(async () => ({})),
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

import { stopInstance } from "../services/instance";

describe("stopInstance supplement cleanup", () => {
  beforeEach(() => {
    mockGetInstance.mockClear();
    mockStopInstance.mockClear();
  });

  // core 中不存在实例时清理 supplement
  test("cleans up supplement when instance not in core", async () => {
    mockListInstances.mockReturnValueOnce([]);
    const result = await stopInstance("inst_ghost", "user1");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Instance not found");
  });

  // 已停止实例清理 supplement
  test("cleans up supplement when instance already stopped", async () => {
    const result = await stopInstance("inst_stopped", "user1");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Instance not found");
  });

  // 正常停止返回成功
  test("returns not found for nonexistent instance", async () => {
    const result = await stopInstance("inst_nonexistent", "user1");
    expect(result.ok).toBe(false);
  });
});
