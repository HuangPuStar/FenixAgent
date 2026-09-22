/**
 * spawnInstanceViaCore nodeId 快照传递测试（A-P2.2 回归）。
 *
 * 根因：controller.spawnInstance 读 env 决定 machineId（ensureNode 的 refCount +1 记在
 * 此节点），spawnInstanceViaCore 重读 env 重新推导 nodeId（实例实际启动的节点）。
 * 两次读取之间 agent_config.machineId 变更时，refCount 记在旧节点、实例却启动在新节点
 * （TOCTOU）。修复后 nodeId 直接取 Instance.machineId 快照——与 ensureNode 严格同源。
 *
 * environmentOrchestrationRepo 已从 setOrchestrationInstanceDeps 注入接口移除
 * （spawnInstanceViaCore 不再重读 env），"零调用"由依赖移除结构性保证，无需注入
 * 计数 repo 断言；用例 1 的 nodeId 快照断言即其行为等价物。
 *
 * 注入方式（禁 mock.module，全部用既有 seam）：
 *   - setOrchestrationInstanceDeps：覆盖 environmentRepo / buildAgentLaunchSpecForCore /
 *     getOrchestrationController；
 *   - core 单例经包内 `../server/testing` 的 stubCoreRuntimeFacade 注入假 facade。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CoreRuntimeFacade, LaunchInstanceRequest } from "@fenix/core";
import type { AgentController, Instance } from "@fenix/orchestration";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
import type { EnvironmentRecord, IEnvironmentRepo } from "../server/repositories/environment";
import { initializeAgentRuntimeModuleConfig, stubAgentRuntimeConfig, stubCoreRuntimeFacade } from "../server/testing";
import { globalInstanceRegistry } from "../services/instance-registry";
import {
  type LaunchTargetRef,
  resetOrchestrationInstanceDeps,
  setOrchestrationInstanceDeps,
  spawnInstanceViaController,
  spawnInstanceViaCore,
} from "../services/orchestration-instance";

const ENV_ID = "env-1";
const USER_ID = "user-1";
const INSTANCE_ID = "inst_test";

/** 记录 facade.launchInstance 收到的参数；nodeId 断言的核心观察点。 */
const launchCalls: Array<Pick<LaunchInstanceRequest, "instanceId" | "nodeId" | "engineType">> = [];

const fakeFacade = {
  launchInstance: async (request: LaunchInstanceRequest) => {
    launchCalls.push({ instanceId: request.instanceId, nodeId: request.nodeId, engineType: request.engineType });
    return {};
  },
  stopInstance: async () => {},
  listInstances: () => [],
} as unknown as CoreRuntimeFacade;

/** 假 controller：spawnInstance 直接返回携带 machineId 快照的 Instance。 */
const fakeController = {
  spawnInstance: async (_envId: string, _userId: string) =>
    ({ instanceId: INSTANCE_ID, environmentId: ENV_ID, userId: USER_ID, machineId: "mach_A" }) as unknown as Instance,
  stopInstance: async () => {},
} as unknown as AgentController;

/** 直接调用 spawnInstanceViaCore 的最小启动身份（跳过组装链，聚焦 nodeId 透传）。 */
const MINIMAL_TARGET: LaunchTargetRef = { environmentId: ENV_ID, userId: USER_ID };

/** 假 buildAgentLaunchSpecForCore：跳过 DB 构建链，隔离 core 侧配置组装。 */
const fakeBuildAgentLaunchSpecForCore = async (_target: LaunchTargetRef, _extraEnv?: Record<string, string>) =>
  ({ workspace: "/tmp/ws", env: {}, agent: { name: "test" } }) as unknown as AgentLaunchSpec;

/** 假 environmentRepo：仅 serve registerSupplement 的 env 查询。 */
const fakeEnvironmentRepo = {
  getById: async (_id: string) =>
    ({
      organizationId: "org-1",
      userId: USER_ID,
      agentConfigId: null,
      secret: "env-secret",
    }) as unknown as EnvironmentRecord,
} as unknown as IEnvironmentRepo;

describe("spawnInstanceViaCore nodeId snapshot", () => {
  beforeEach(() => {
    globalInstanceRegistry.clear();
    resetOrchestrationInstanceDeps();
    // 并发上限归模块配置（缺省基线即「三个上限都不生效」）；`defaultEngineType` 1.5b 起同归模块配置，
    // 缺省基线即 `undefined`（调用方回退 `"opencode"`），需要时用例内用 `stubAgentRuntimeConfig` 覆盖。
    initializeAgentRuntimeModuleConfig();
    launchCalls.length = 0;
    stubCoreRuntimeFacade(fakeFacade);
    setOrchestrationInstanceDeps({
      environmentRepo: fakeEnvironmentRepo,
      buildAgentLaunchSpecForCore: fakeBuildAgentLaunchSpecForCore,
      getOrchestrationController: () => fakeController,
    });
  });

  afterEach(() => {
    resetOrchestrationInstanceDeps();
    resetAllStubs();
    globalInstanceRegistry.clear();
  });

  // A-P2.2 回归：core nodeId 必须恒等于 controller 返回的 Instance.machineId 快照，
  // 旧行为在两次读取间 machineId 变更时会把实例启到新节点（与 refCount 旧节点错位），
  // 本用例锁定"只认 controller 快照"语义——controller 返回 mach_A 则必须启动在 mach_A
  test("nodeId equals the Instance.machineId snapshot from controller", async () => {
    await spawnInstanceViaController(ENV_ID, USER_ID, "interactive", { instanceUid: "inst_test_nodeid" });

    expect(launchCalls).toHaveLength(1);
    expect(launchCalls[0].instanceId).toBe(INSTANCE_ID);
    expect(launchCalls[0].nodeId).toBe("mach_A");
    // mach_A 非 local-default：走 remote 分支，不传 engineType（既有语义保留）
    expect(launchCalls[0].engineType).toBeUndefined();
    // 全流程成功：supplement 正常注册，回滚未误触发
    expect(globalInstanceRegistry.get(INSTANCE_ID)?.environmentId).toBe(ENV_ID);
  });

  // remote 分支透传：直接调用 spawnInstanceViaCore 时 nodeId 原样进入 launchInstance，
  // engineType 保持 undefined（remote 由 machine 端自行决定引擎）
  test("spawnInstanceViaCore passes nodeId through on remote branch", async () => {
    await spawnInstanceViaCore(MINIMAL_TARGET, "inst-1", "mach_remote");

    expect(launchCalls).toHaveLength(1);
    expect(launchCalls[0]).toMatchObject({ instanceId: "inst-1", nodeId: "mach_remote" });
    expect(launchCalls[0].engineType).toBeUndefined();
  });

  // local-default 分支：本地执行时 engineType 由模块配置的 defaultEngineType 透传，
  // nodeId 仍为传入的 local-default 快照
  test("local-default branch keeps engineType passthrough", async () => {
    stubAgentRuntimeConfig({ defaultEngineType: "ccb" });

    await spawnInstanceViaCore(MINIMAL_TARGET, "inst-1", "local-default");

    expect(launchCalls).toHaveLength(1);
    expect(launchCalls[0]).toMatchObject({ instanceId: "inst-1", nodeId: "local-default", engineType: "ccb" });
  });
});
