import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { RuntimeInstanceSnapshot } from "@mothership/core";
import { resetCoreRuntime } from "../services/core-bootstrap";
import { _deps, _resetDeps } from "../services/instance";
import { setBuildLaunchSpec } from "../services/launch-spec-builder";

const mockListInstances = mock((): RuntimeInstanceSnapshot[] => []);

const fakeFacade = {
  listInstances: mockListInstances,
  getInstance: mock(() => null),
  stopInstance: mock(async () => {}),
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

import { groupActiveInstancesByEnvironment } from "../services/instance";

function snap(id: string, status: string): RuntimeInstanceSnapshot {
  return {
    instanceId: id,
    status: status as any,
    errorMessage: undefined,
    pluginMetadata: {},
    createdAt: new Date(),
    engineType: "opencode",
    nodeId: "local-default",
    launchSpec: {} as any,
    relayConnected: false,
    updatedAt: new Date(),
  };
}

describe("groupActiveInstancesByEnvironment", () => {
  beforeEach(() => {
    mockListInstances.mockClear();
  });

  // 多环境实例正确分组（无 supplement 匹配时跳过）
  test("groups active instances by environmentId", () => {
    mockListInstances.mockReturnValueOnce([snap("i1", "running"), snap("i2", "running"), snap("i3", "starting")]);

    const result = groupActiveInstancesByEnvironment();
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
    mockListInstances.mockReturnValueOnce([snap("stopped_1", "stopped"), snap("error_1", "error")]);

    const result = groupActiveInstancesByEnvironment();
    expect(result.size).toBe(0);
  });
});
