import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { RuntimeInstanceSnapshot } from "@mothership/core";
import { resetCoreRuntime } from "../services/core-bootstrap";
import { _deps, _resetDeps } from "../services/instance";
import { setBuildLaunchSpec } from "../services/launch-spec-builder";

const mockGetInstance = mock((): RuntimeInstanceSnapshot | null => null);
const mockListInstances = mock((): RuntimeInstanceSnapshot[] => []);
const fakeFacade = {
  listInstances: mockListInstances,
  getInstance: mockGetInstance,
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

import { getInstance } from "../services/instance";

describe("getInstance supplement cleanup on stale core", () => {
  beforeEach(() => {
    mockGetInstance.mockClear();
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
    } as any as RuntimeInstanceSnapshot);
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
    } as any as RuntimeInstanceSnapshot);
    const result = getInstance("inst_orphan");
    expect(result).toBeUndefined();
  });
});
