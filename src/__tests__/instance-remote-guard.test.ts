import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AppError } from "../errors";
import { resetCoreRuntime, setCoreRuntimeFactory } from "../services/core-bootstrap";
import { spawnInstanceFromEnvironment } from "../services/instance";
import { setBuildLaunchSpec } from "../services/launch-spec-builder";
import { resetAllStubs, stubConfigPg } from "../test-utils/helpers";

const now = new Date("2026-06-04T00:00:00.000Z");

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    id: "env_test",
    name: "test-env",
    description: null,
    workspacePath: "/tmp/test",
    agentConfigId: "agc_test",
    secret: "sec_test",
    machineName: null,
    directory: null,
    branch: null,
    gitRepoUrl: null,
    maxSessions: 1,
    workerType: "acp",
    capabilities: null,
    status: "idle",
    username: null,
    userId: "user_1",
    organizationId: "org_1",
    autoStart: true,
    lastPollAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeAgentConfig(overrides: Record<string, unknown> = {}) {
  return {
    id: "agc_test",
    userId: "user_1",
    organizationId: "org_1",
    name: "test-agent",
    prompt: "test prompt",
    model: "org_1/provider_1/model_1",
    steps: 10,
    mode: "primary",
    permission: null,
    variant: null,
    temperature: null,
    topP: null,
    disable: false,
    hidden: false,
    color: null,
    description: null,
    knowledge: null,
    machineId: null,
    createdAt: now,
    updatedAt: now,
    resourceAccess: { ownership: "internal" as const },
    ...overrides,
  };
}

/** buildLaunchSpec 在守卫之前执行，需要 mock 以通过 */
const dummyLaunchSpec = {
  organizationId: "org_1",
  userId: "user_1",
  environmentId: "env_test",
  env: {},
  agent: { name: "test-agent" },
  model: { provider: "openai", protocol: "openai" as const, baseUrl: "", apiKey: "", model: "gpt-4o" },
  skills: [],
  mcpServers: [],
};

describe("spawnInstanceFromEnvironment 远程节点守卫", () => {
  beforeEach(() => {
    resetAllStubs();
    // mock buildLaunchSpec 以跳过 provider/model/skill 解析
    setBuildLaunchSpec(async () => dummyLaunchSpec as never);
  });

  afterEach(() => {
    setBuildLaunchSpec(null);
    resetCoreRuntime();
    setCoreRuntimeFactory(null);
  });

  // 本地节点不触发连接检查，守卫逻辑被跳过
  test("本地节点不检查连接，跳过守卫逻辑", async () => {
    stubConfigPg({
      getReadableAgentConfigById: async () => makeAgentConfig({ machineId: null }),
    });

    // mock core runtime facade 让 launchInstance 成功
    setCoreRuntimeFactory(
      () =>
        ({
          launchInstance: async () => ({
            instanceId: "inst_mock",
            nodeId: "local-default",
            status: "running",
            engineType: "opencode",
            createdAt: new Date(),
            pluginMetadata: { port: 3001, pid: 1234, token: "tok_mock" },
          }),
          listInstances: () => [],
          getInstance: () => undefined,
          stopInstance: async () => {},
          deleteInstance: () => {},
          registerNode: () => {},
          getNode: () => undefined,
          updateNodeStatus: () => {},
        }) as never,
    );

    const result = await spawnInstanceFromEnvironment("user_1", "env_test", makeEnv());

    // 验证未抛 MACHINE_OFFLINE，正常返回结果
    expect(result.id).toBe("inst_mock");
    expect(result.status).toBe("running");
  });

  // 远程节点离线时抛出 503 MACHINE_OFFLINE
  test("远程节点离线时抛出 MACHINE_OFFLINE (503)", async () => {
    stubConfigPg({
      getReadableAgentConfigById: async () => makeAgentConfig({ machineId: "mach_offline_001" }),
    });

    // findMachineConnectionById 查内存 Map，测试环境下无 WS 连接，自然返回 null
    try {
      await spawnInstanceFromEnvironment("user_1", "env_test", makeEnv());
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const appErr = err as AppError;
      expect(appErr.statusCode).toBe(503);
      expect(appErr.code).toBe("MACHINE_OFFLINE");
      expect(appErr.message).toContain("未连接");
    }
  });
});
