import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { RuntimeInstanceSnapshot } from "@mothership/core";
import { resetCoreRuntime } from "../services/core-bootstrap";
import { _deps, _resetDeps } from "../services/instance";
import { setBuildLaunchSpec } from "../services/launch-spec-builder";

const mockListInstances = mock((): RuntimeInstanceSnapshot[] => []);
const mockGetInstance = mock((_id?: any) => undefined as RuntimeInstanceSnapshot | undefined);
const mockStopInstance = mock(async (_id?: any) => {});
const mockLaunchInstance = mock(
  async (spec: any) =>
    ({
      instanceId: spec.instanceId,
      status: "running",
      pluginMetadata: {},
      errorMessage: null,
      createdAt: new Date(),
    }) as any as RuntimeInstanceSnapshot,
);

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
  _deps.environmentRepo = {
    getById: mock(async () => ({
      id: "env_1",
      userId: "u1",
      teamId: "u1",
      secret: "s1",
      maxSessions: 5,
      workspacePath: "/tmp/ws1",
    })),
  } as any;
  _deps.findOrCreateForEnvironment = mock(async () => ({ id: "ses_1" })) as any;
  setBuildLaunchSpec(mock(async () => ({})) as any);
});

afterEach(() => {
  _resetDeps();
  setBuildLaunchSpec(null);
});

import { getRunningInstancesByEnvironment, spawnInstanceFromEnvironment, stopInstance } from "../services/instance";

describe("stopInstance envInstanceCounters cleanup", () => {
  test("clears counter when last instance stopped", async () => {
    const snapshots: RuntimeInstanceSnapshot[] = [];

    mockLaunchInstance.mockImplementation(async (spec: any) => {
      const s = {
        instanceId: spec.instanceId,
        status: "running" as const,
        pluginMetadata: { port: 8888, pid: 1234, token: "abc" },
        errorMessage: undefined,
        createdAt: new Date(),
        engineType: "opencode",
        nodeId: "local-default",
        launchSpec: {} as any,
        relayConnected: false,
        updatedAt: new Date(),
      } as any as RuntimeInstanceSnapshot;
      snapshots.push(s);
      mockListInstances.mockImplementation(() => [...snapshots]);
      mockGetInstance.mockImplementation((id: string) => snapshots.find((s) => s.instanceId === id) as any);
      return s;
    });

    const inst = await spawnInstanceFromEnvironment("u1", "env_1");
    expect(inst.id).toBeTruthy();

    const before = getRunningInstancesByEnvironment("env_1");
    expect(before.length).toBe(1);

    mockStopInstance.mockImplementation(async () => {
      snapshots.length = 0;
      mockListInstances.mockImplementation(() => []);
      mockGetInstance.mockImplementation(() => undefined);
    });

    const result = await stopInstance(inst.id, "u1");
    expect(result.ok).toBe(true);

    const after = getRunningInstancesByEnvironment("env_1");
    expect(after.length).toBe(0);
  });

  test("preserves counter when other instances remain", async () => {
    const snapshots: RuntimeInstanceSnapshot[] = [];

    mockLaunchInstance.mockImplementation(async (spec: any) => {
      const s = {
        instanceId: spec.instanceId,
        status: "running" as const,
        pluginMetadata: { port: 8888 + snapshots.length, pid: 100 + snapshots.length, token: `tok${snapshots.length}` },
        errorMessage: undefined,
        createdAt: new Date(),
        engineType: "opencode",
        nodeId: "local-default",
        launchSpec: {} as any,
        relayConnected: false,
        updatedAt: new Date(),
      } as any as RuntimeInstanceSnapshot;
      snapshots.push(s);
      mockListInstances.mockImplementation(() => [...snapshots]);
      mockGetInstance.mockImplementation((id: string) => snapshots.find((s) => s.instanceId === id) as any);
      return s;
    });

    const inst1 = await spawnInstanceFromEnvironment("u1", "env_1");
    const inst2 = await spawnInstanceFromEnvironment("u1", "env_1");

    const before = getRunningInstancesByEnvironment("env_1");
    expect(before.length).toBe(2);

    mockStopInstance.mockImplementation(async (id: string) => {
      const idx = snapshots.findIndex((s) => s.instanceId === id);
      if (idx >= 0) snapshots.splice(idx, 1);
      mockListInstances.mockImplementation(() => [...snapshots]);
      mockGetInstance.mockImplementation((checkId: string) => snapshots.find((s) => s.instanceId === checkId) as any);
    });

    const result = await stopInstance(inst1.id, "u1");
    expect(result.ok).toBe(true);

    const remaining = getRunningInstancesByEnvironment("env_1");
    expect(remaining.length).toBe(1);
    expect(remaining[0].id).toBe(inst2.id);
  });
});
