import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CoreRuntimeFacade, LaunchInstanceRequest } from "@fenix/core";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
import type { EnvironmentRecord, IEnvironmentRepo } from "../server/repositories/environment";
import { bindAgentConfigLookupPort, resetAgentConfigLookupPort } from "../server/services/agent-config-lookup-port";
import { initializeAgentRuntimeModuleConfig, stubAgentLaunchSpecPort, stubCoreRuntimeFacade } from "../server/testing";
import {
  resetOrchestrationInstanceDeps,
  setOrchestrationInstanceDeps,
  spawnInstanceViaCore,
} from "../services/orchestration-instance";

const environment: EnvironmentRecord = {
  id: "env-identity",
  name: "identity",
  description: null,
  workspacePath: "unused",
  agentConfigId: "agent-identity",
  secret: "",
  machineName: null,
  directory: null,
  branch: null,
  gitRepoUrl: null,
  workerType: "acp",
  capabilities: null,
  status: "active",
  username: null,
  userId: "user-owner",
  organizationId: "org-owner",
  autoStart: false,
  lastPollAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

/** 保留真实运行时变量组装，仅替换资源解析与进程启动。 */
function buildSpec(request: {
  environmentId: string;
  organizationId: string;
  ownerUserId: string;
  extraEnv?: Record<string, string>;
}): AgentLaunchSpec {
  return {
    organizationId: request.organizationId,
    userId: request.ownerUserId,
    environmentId: request.environmentId,
    env: request.extraEnv,
    agent: { name: "identity" },
    model: { provider: "test", protocol: "openai", baseUrl: "http://test.invalid", apiKey: "", model: "test" },
    skills: [],
    mcpServers: [],
  };
}

describe("Agent 启动身份环境变量", () => {
  let agentConfigId: string | null;
  let launchedSpec: AgentLaunchSpec | undefined;

  beforeEach(() => {
    initializeAgentRuntimeModuleConfig();
    resetOrchestrationInstanceDeps();
    resetAgentConfigLookupPort();
    bindAgentConfigLookupPort({
      findAgentConfig: async () => null,
      findVisibleAgentConfig: async () => null,
      findAgentConfigExecutionFields: async () => null,
      findAgentConfigNamesByIds: async () => new Map(),
    });
    agentConfigId = environment.agentConfigId;
    launchedSpec = undefined;
    setOrchestrationInstanceDeps({
      environmentRepo: {
        getById: async () => ({ ...environment, agentConfigId }),
      } as IEnvironmentRepo,
    });
    stubAgentLaunchSpecPort({
      buildAgentLaunchSpec: async (request) => buildSpec(request),
      buildMinimalAgentLaunchSpec: async (request) => buildSpec(request),
    });
    stubCoreRuntimeFacade({
      launchInstance: async (request: LaunchInstanceRequest) => {
        launchedSpec = request.launchSpec;
      },
    } as unknown as CoreRuntimeFacade);
  });

  afterEach(() => {
    resetOrchestrationInstanceDeps();
    resetAgentConfigLookupPort();
    resetAllStubs();
  });

  // 两种执行位置使用同一份环境身份，远端启动同样必须能追溯站点创建者。
  test.each(["local-default", "machine-remote"])("%s 启动注入 environment 绑定的身份", async (machineId) => {
    await spawnInstanceViaCore({ environmentId: environment.id, userId: "user-owner" }, "instance-1", machineId);

    expect(launchedSpec?.env).toMatchObject({
      AGENT_CONFIG_ID: "agent-identity",
      ENVIRONMENT_ID: "env-identity",
    });
  });

  // 调用方仍能覆盖请求者上下文，但不能把当前 environment 身份替换为其他 Agent。
  test("extraEnv 不能覆盖服务端解析的启动身份", async () => {
    await spawnInstanceViaCore({ environmentId: environment.id, userId: "user-owner" }, "instance-1", "local-default", {
      AGENT_CONFIG_ID: "agent-other",
      ENVIRONMENT_ID: "env-other",
      USER_META_USER_ID: "request-user",
    });

    expect(launchedSpec?.env).toMatchObject({
      AGENT_CONFIG_ID: "agent-identity",
      ENVIRONMENT_ID: "env-identity",
      USER_META_USER_ID: "request-user",
    });
  });

  // 未绑定配置的环境不能继承或伪造创建者，空值让 skill 显式停止创建。
  test("最小启动路径保留环境 ID，Agent 配置 ID 为空", async () => {
    agentConfigId = null;
    await spawnInstanceViaCore({ environmentId: environment.id, userId: "user-owner" }, "instance-1", "local-default", {
      AGENT_CONFIG_ID: "agent-other",
    });

    expect(launchedSpec?.env).toMatchObject({ AGENT_CONFIG_ID: "", ENVIRONMENT_ID: "env-identity" });
  });
});
