import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { RuntimeInstanceSnapshot } from "@mothership/core";
import { resetCoreRuntime } from "../services/core-bootstrap";
import { _deps, _resetDeps } from "../services/instance";
import { setBuildLaunchSpec } from "../services/launch-spec-builder";

const mockListInstances = mock((): RuntimeInstanceSnapshot[] => []);
const mockStopInstance = mock(async (_id: string) => {});

const fakeFacade = {
  listInstances: mockListInstances,
  getInstance: mock(() => null),
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

import { listInstances, stopAllInstances } from "../services/instance";

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

describe("stopAllInstances skips stopping status", () => {
  beforeEach(() => {
    mockListInstances.mockClear();
    mockStopInstance.mockClear();
  });

  // 跳过 stopped/stopping，只 stop running 和 error
  test("skips stopped and stopping instances, only stops running ones", async () => {
    mockListInstances.mockReturnValueOnce([
      snap("inst_1", "running"),
      snap("inst_2", "stopped"),
      snap("inst_3", "stopping"),
      snap("inst_4", "error"),
    ]);

    await stopAllInstances();

    expect(mockStopInstance).toHaveBeenCalledTimes(2);
    expect(mockStopInstance.mock.calls[0][0] as string).toBe("inst_1");
    expect(mockStopInstance.mock.calls[1][0] as string).toBe("inst_4");
  });

  // 全部 stopped/stopping 时无需 stop
  test("no stops when all instances are stopped", async () => {
    mockListInstances.mockReturnValueOnce([snap("inst_a", "stopped"), snap("inst_b", "stopping")]);

    await stopAllInstances();
    expect(mockStopInstance).not.toHaveBeenCalled();
  });

  // 无实例时正常退出
  test("handles empty instance list", async () => {
    mockListInstances.mockReturnValueOnce([]);
    await stopAllInstances();
    expect(mockStopInstance).not.toHaveBeenCalled();
  });
});

describe("listInstances filters entries without supplement", () => {
  beforeEach(() => {
    mockListInstances.mockClear();
  });

  test("returns empty when no supplements match", () => {
    mockListInstances.mockReturnValueOnce([snap("inst_orphan", "running")]);
    const result = listInstances("user_1");
    expect(result).toEqual([]);
  });
});
