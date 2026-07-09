import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AppError } from "../errors";
import { connectAgentChat, setAgentChatServiceDeps } from "../services/agent-chat-service";

function makeMockRelayHandle() {
  return {
    state: "open" as const,
    send: () => {},
    close: async () => {},
    onMessage: () => () => {},
    ready: Promise.resolve(),
  };
}

describe("connectAgentChat", () => {
  beforeEach(() => {
    setAgentChatServiceDeps({
      getReadableAgentConfigById: async () => ({ id: "agc-test", name: "test-agent" }),
      createWebEnvironment: async () => ({
        id: "env-test",
        name: "test",
        agentConfigId: "agc-test",
        userId: "u1",
        organizationId: "org1",
        secret: "s",
        status: "idle",
        description: null,
        autoStart: true,
        maxSessions: 1,
        workspacePath: "/ws",
        machineName: null,
        workerType: "acp",
        branch: null,
        gitRepoUrl: null,
        capabilities: null,
        lastPollAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      groupActiveInstancesByEnvironment: () => new Map(),
      getRunningInstancesByEnvironment: () => [],
      listEnvironmentsByOrganizationId: async () => [],
      spawnInstanceFromEnvironment: async () => ({
        id: "inst-test",
        userId: "u1",
        port: 12345,
        pid: null,
        status: "running" as const,
        command: "test",
        error: null,
        apiKey: "k",
        createdAt: new Date(),
        instanceNumber: 1,
      }),
      getCoreRuntime: () =>
        ({
          launchInstance: async () => {},
          connectInstanceRelay: async () => makeMockRelayHandle(),
          stopInstance: async () => {},
          listInstances: () => [],
          registerPlugin: () => ({}),
          registerNode: () => ({}),
          getInstance: () => null,
          getNode: () => null,
          getPlugin: () => null,
          listNodes: () => [],
          listPlugins: () => [],
          updateNodeStatus: () => ({}),
          deleteInstance: () => false,
          updateInstanceMetadata: () => ({}) as any,
        }) as any,
    } as any);
  });

  afterEach(() => {
    setAgentChatServiceDeps(null);
  });

  // 正常连接
  test("正常连接 Agent 返回 AgentSession", async () => {
    const session = await connectAgentChat({
      agentConfigId: "agc-test",
      organizationId: "org1",
      userId: "u1",
    });
    expect(session.instanceId).toBe("inst-test");
    expect(session.relayHandle).toBeDefined();
    expect(session.relayHandle.state).toBe("open");
  });

  // Agent 不存在
  test("Agent 不存在时抛出 AppError", async () => {
    setAgentChatServiceDeps({
      ...({} as any),
      getReadableAgentConfigById: async () => null,
    } as any);
    await expect(
      connectAgentChat({ agentConfigId: "not-exist", organizationId: "org1", userId: "u1" }),
    ).rejects.toThrow(AppError);
  });

  // dispose
  test("dispose 关闭 relay handle 并 stop 实例", async () => {
    let closed = false;
    let stopped = false;
    setAgentChatServiceDeps({
      getReadableAgentConfigById: async () => ({ id: "agc-test", name: "test" }),
      createWebEnvironment: async () => ({
        id: "env-test",
        name: "test",
        agentConfigId: "agc-test",
        userId: "u1",
        organizationId: "org1",
        secret: "s",
        status: "idle",
        description: null,
        autoStart: true,
        maxSessions: 1,
        workspacePath: "/ws",
        machineName: null,
        workerType: "acp",
        branch: null,
        gitRepoUrl: null,
        capabilities: null,
        lastPollAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      groupActiveInstancesByEnvironment: () => new Map(),
      getRunningInstancesByEnvironment: () => [],
      listEnvironmentsByOrganizationId: async () => [],
      spawnInstanceFromEnvironment: async () => ({
        id: "inst-test",
        userId: "u1",
        port: 12345,
        pid: null,
        status: "running" as const,
        command: "test",
        error: null,
        apiKey: "k",
        createdAt: new Date(),
        instanceNumber: 1,
      }),
      getCoreRuntime: () =>
        ({
          launchInstance: async () => {},
          connectInstanceRelay: async () => ({
            state: "open" as const,
            send: () => {},
            close: async () => {
              closed = true;
            },
            onMessage: () => () => {},
            ready: Promise.resolve(),
          }),
          stopInstance: async () => {
            stopped = true;
          },
          listInstances: () => [],
          registerPlugin: () => ({}),
          registerNode: () => ({}),
          getInstance: () => null,
          getNode: () => null,
          getPlugin: () => null,
          listNodes: () => [],
          listPlugins: () => [],
          updateNodeStatus: () => ({}),
          deleteInstance: () => false,
          updateInstanceMetadata: () => ({}) as any,
        }) as any,
    } as any);

    const session = await connectAgentChat({
      agentConfigId: "agc-test",
      organizationId: "org1",
      userId: "u1",
    });
    await session.dispose();
    expect(closed).toBe(true);
    expect(stopped).toBe(true);
  });
});
