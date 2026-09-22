/**
 * spawnInstanceViaController 失败回滚测试（A/D-P1.3）。
 *
 * 背景：registerSupplement 原位于 try/catch 之外，其内部唯一异步失败点
 * environmentRepo.getById（DB 查询）抛错时，core 进程已启动、controller 活跃表
 * 已注册、节点 refCount 已 +1，但 supplement 缺失 → idle 监控按 supplement 判断
 * 永不回收，实例成为仅 stopAllInstances 可清的永久孤儿。
 *
 * 注入方式（禁 mock.module，全部用既有 seam）：
 *   - setOrchestrationInstanceDeps：覆盖 environmentRepo / getOrchestrationController；
 *   - 保留真实 buildAgentLaunchSpecForCore（它先读环境行，再经 AgentLaunchSpecPort 组装），使
 *     environmentRepo.getById 的"第 1 次成功（launch 构建链）、第 2 次抛错（registerSupplement）"
 *     序号注入可达——若连环境行读取一起替换掉，getById 只剩 registerSupplement 一个调用方，
 *     无法区分失败点。组装端口本身用替身（W4b 后未装配即失败），本文件不断言 spec 内容；
 *   - core-bootstrap 被 setup-mocks.ts 全局 mock，setCoreRuntimeFactory 不可用，
 *     改用包内 `../server/testing` 的 stubCoreRuntimeFacade 注入假 facade。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CoreRuntimeFacade } from "@fenix/core";
import type { AgentController, Instance } from "@fenix/orchestration";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import type { EnvironmentRecord, IEnvironmentRepo } from "../server/repositories/environment";
import { initializeAgentRuntimeModuleConfig, stubAgentLaunchSpecPort, stubCoreRuntimeFacade } from "../server/testing";
import { globalInstanceRegistry } from "../services/instance-registry";
import {
  resetOrchestrationInstanceDeps,
  setOrchestrationInstanceDeps,
  spawnInstanceViaController,
} from "../services/orchestration-instance";

const ENV_ID = "env-1";
const USER_ID = "user-1";
const INSTANCE_ID = "inst_test";

/** 记录 controller.stopInstance 调用；仅此一处状态被假 controller 修改。 */
const controllerStopCalls: string[] = [];
/** 记录 facade.stopInstance 调用。 */
const facadeStopCalls: string[] = [];
/** environmentRepo.getById 调用计数：用于区分 launch 构建链（第 1 次）与 registerSupplement（第 2 次）。 */
let getByIdCalls = 0;
/** 为 true 时 registerSupplement 的 env 查询（getById 第 2 次）抛错。 */
let failOnSecondCall = false;
/** 为 true 时 facade.launchInstance 抛错（launch 失败路径回归用）。 */
let launchShouldFail = false;

const fakeController = {
  spawnInstance: async (_envId: string, _userId: string) =>
    // machineId 为 local-default：走本地 launch 分支，避免远程节点依赖
    ({
      instanceId: INSTANCE_ID,
      environmentId: ENV_ID,
      userId: USER_ID,
      machineId: "local-default",
    }) as unknown as Instance,
  stopInstance: async (instanceId: string) => {
    controllerStopCalls.push(instanceId);
  },
} as unknown as AgentController;

const fakeEnvironmentRepo = {
  getById: async (_id: string) => {
    getByIdCalls += 1;
    if (failOnSecondCall && getByIdCalls === 2) throw new Error("db down");
    // 无 agentConfigId：buildAgentLaunchSpecForCore 走最小 spec 分支；组装端口已被替身装配，
    // 因此这里读到环境行即可，不再需要供 provider/model 行
    return {
      organizationId: "org-1",
      userId: USER_ID,
      agentConfigId: null,
      secret: "env-secret",
    } as unknown as EnvironmentRecord;
  },
} as unknown as IEnvironmentRepo;

const fakeFacade = {
  launchInstance: async () => {
    if (launchShouldFail) throw new Error("launch failed");
    return {};
  },
  stopInstance: async (instanceId: string) => {
    facadeStopCalls.push(instanceId);
  },
  listInstances: () => [],
} as unknown as CoreRuntimeFacade;

describe("spawnInstanceViaController rollback", () => {
  beforeEach(() => {
    globalInstanceRegistry.clear();
    resetOrchestrationInstanceDeps();
    // 并发上限归模块配置（不再是宿主 config）：缺省基线即「三个上限都不生效」，
    // 本文件只关心回滚语义，不需要限额。内含 resetAllStubs，故必须在本行之后装配端口替身。
    initializeAgentRuntimeModuleConfig();
    getByIdCalls = 0;
    failOnSecondCall = false;
    launchShouldFail = false;
    controllerStopCalls.length = 0;
    facadeStopCalls.length = 0;
    stubCoreRuntimeFacade(fakeFacade);
    // 无 agentConfigId 的环境走最小 spec 分支，但走不走哪一支不是本文件的事：装配替身后
    // 组装链不再是失败点，getById 的序号注入才能锚定到 registerSupplement
    stubAgentLaunchSpecPort();
    setOrchestrationInstanceDeps({
      environmentRepo: fakeEnvironmentRepo,
      getOrchestrationController: () => fakeController,
    });
  });

  afterEach(() => {
    resetOrchestrationInstanceDeps();
    resetAllStubs();
    globalInstanceRegistry.clear();
  });

  // registerSupplement 的 env 查询（getById 第 2 次）抛错时，须回滚 controller 活跃表、
  // core 进程与 supplement 三侧状态，且错误原样上抛
  test("registerSupplement failure rolls back controller, core and registry", async () => {
    failOnSecondCall = true;

    await expect(
      spawnInstanceViaController(ENV_ID, USER_ID, "interactive", { instanceUid: "inst_test_rollback" }),
    ).rejects.toThrow("db down");

    expect(controllerStopCalls).toEqual([INSTANCE_ID]);
    expect(facadeStopCalls).toEqual([INSTANCE_ID]);
    expect(globalInstanceRegistry.get(INSTANCE_ID)).toBeUndefined();
    expect(globalInstanceRegistry.size).toBe(0);
  });

  // launch 失败路径回归：统一回滚入口不改变原语义——controller 仍被回滚、错误仍原样上抛，
  // 新增的 facade.stopInstance 对 core 无实例场景幂等吞错
  test("launch failure still rolls back controller and propagates error", async () => {
    launchShouldFail = true;

    await expect(
      spawnInstanceViaController(ENV_ID, USER_ID, "interactive", { instanceUid: "inst_test_rollback" }),
    ).rejects.toThrow("launch failed");

    expect(controllerStopCalls).toEqual([INSTANCE_ID]);
    expect(facadeStopCalls).toEqual([INSTANCE_ID]);
    expect(globalInstanceRegistry.size).toBe(0);
  });

  // 成功路径回归：supplement 正常注册且回滚不误触发（两处 stop 均不应被调用）
  test("successful spawn registers supplement without triggering rollback", async () => {
    const instance = await spawnInstanceViaController(ENV_ID, USER_ID, "interactive", {
      instanceUid: "inst_test_rollback",
    });

    expect(instance.instanceId).toBe(INSTANCE_ID);
    const sup = globalInstanceRegistry.get(INSTANCE_ID);
    expect(sup?.environmentId).toBe(ENV_ID);
    expect(sup?.userId).toBe(USER_ID);
    expect(sup?.organizationId).toBe("org-1");
    expect(controllerStopCalls).toHaveLength(0);
    expect(facadeStopCalls).toHaveLength(0);
  });
});
