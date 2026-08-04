/**
 * spawnInstanceViaController 失败回滚测试（A/D-P1.3）。
 *
 * 背景：registerSupplement 原位于 try/catch 之外，其内部唯一异步失败点
 * environmentRepo.getById（DB 查询）抛错时，core 进程已启动、controller 活跃表
 * 已注册、节点 refCount 已 +1，但 supplement 缺失 → idle 监控按 supplement 判断
 * 永不回收，实例成为仅 stopAllInstances 可清的永久孤儿。
 *
 * 注入方式（禁 mock.module，全部用既有 seam）：
 *   - setOrchestrationInstanceDeps：覆盖 environmentRepo /
 *     getOrchestrationController / getOrchestrationLaunchSpecBuilder；
 *   - 保留真实 buildAgentLaunchSpecForCore（无 agentConfigId 环境走 buildBasicLaunchSpec
 *     分支，需 stubDb 提供 provider/model 行），使 environmentRepo.getById 的
 *     "第 1 次成功（launch 构建链）、第 2 次抛错（registerSupplement）"序号注入可达——
 *     若替换 build 链，getById 只剩 registerSupplement 一个调用方，无法区分失败点；
 *   - core-bootstrap 被 setup-mocks.ts 全局 mock，setCoreRuntimeFactory 不可用，
 *     改用 stubCoreBootstrap("getCoreRuntime") 注入假 facade。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CoreRuntimeFacade } from "@fenix/core";
import type { AgentController, Instance, LaunchSpec, LaunchSpecBuilder } from "@fenix/orchestration";
import { config, setConfig } from "../config";
import { provider } from "../db/schema";
import type { EnvironmentRecord, IEnvironmentRepo } from "../repositories/environment";
import { globalInstanceRegistry } from "../services/instance-registry";
import {
  resetOrchestrationInstanceDeps,
  setOrchestrationInstanceDeps,
  spawnInstanceViaController,
} from "../services/orchestration-instance";
import { resetAllStubs, stubCoreBootstrap, stubDb } from "../test-utils/helpers";

const ENV_ID = "env-1";
const USER_ID = "user-1";
const INSTANCE_ID = "inst_test";

// 捕获初始配置：afterEach 时恢复，避免并发限制覆盖泄漏到其他用例
const originalConfig = { ...config };

const now = new Date("2026-07-01T00:00:00.000Z");

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

const fakeLaunchSpecBuilder = {
  build: async (_envId: string, _userId: string) =>
    ({ environmentId: ENV_ID, userId: USER_ID }) as unknown as LaunchSpec,
} as unknown as LaunchSpecBuilder;

const fakeEnvironmentRepo = {
  getById: async (_id: string) => {
    getByIdCalls += 1;
    if (failOnSecondCall && getByIdCalls === 2) throw new Error("db down");
    // 无 agentConfigId：真实 buildAgentLaunchSpecForCore 走 buildBasicLaunchSpec 分支，
    // 不触碰 config/agent-knowledge 等 mock 依赖
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
    setConfig({
      agentMaxConcurrency: undefined,
      userAgentMaxConcurrency: undefined,
      scheduledAgentMaxConcurrency: undefined,
    });
    getByIdCalls = 0;
    failOnSecondCall = false;
    launchShouldFail = false;
    controllerStopCalls.length = 0;
    facadeStopCalls.length = 0;
    stubCoreBootstrap({ getCoreRuntime: () => fakeFacade });
    // buildBasicLaunchSpec 的 resolveFirstReadableModelConfig 需要 provider/model 行；
    // 查询结构（where → orderBy，model 查询多一层 limit）与 launch-spec-builder-errors.test.ts 一致
    stubDb({
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            orderBy: () => {
              if (table === provider) {
                return Promise.resolve([
                  {
                    id: "provider-1",
                    userId: USER_ID,
                    organizationId: "org-1",
                    name: "openai",
                    displayName: "OpenAI",
                    protocol: "openai",
                    baseUrl: "https://api.example.com",
                    apiKey: "internal-key",
                    extraOptions: {},
                    createdAt: now,
                    updatedAt: now,
                  },
                ]);
              }
              return {
                limit: async () => [
                  {
                    id: "model-1",
                    organizationId: "org-1",
                    providerId: "provider-1",
                    modelId: "gpt-4o",
                    displayName: "GPT-4o",
                    modalities: null,
                    limitConfig: null,
                    cost: null,
                    options: null,
                    createdAt: now,
                    updatedAt: now,
                  },
                ],
              };
            },
          }),
        }),
      }),
    });
    setOrchestrationInstanceDeps({
      environmentRepo: fakeEnvironmentRepo,
      getOrchestrationController: () => fakeController,
      getOrchestrationLaunchSpecBuilder: () => fakeLaunchSpecBuilder,
    });
  });

  afterEach(() => {
    resetOrchestrationInstanceDeps();
    resetAllStubs();
    globalInstanceRegistry.clear();
    setConfig(originalConfig);
  });

  // registerSupplement 的 env 查询（getById 第 2 次）抛错时，须回滚 controller 活跃表、
  // core 进程与 supplement 三侧状态，且错误原样上抛
  test("registerSupplement failure rolls back controller, core and registry", async () => {
    failOnSecondCall = true;

    await expect(spawnInstanceViaController(ENV_ID, USER_ID, "interactive")).rejects.toThrow("db down");

    expect(controllerStopCalls).toEqual([INSTANCE_ID]);
    expect(facadeStopCalls).toEqual([INSTANCE_ID]);
    expect(globalInstanceRegistry.get(INSTANCE_ID)).toBeUndefined();
    expect(globalInstanceRegistry.size).toBe(0);
  });

  // launch 失败路径回归：统一回滚入口不改变原语义——controller 仍被回滚、错误仍原样上抛，
  // 新增的 facade.stopInstance 对 core 无实例场景幂等吞错
  test("launch failure still rolls back controller and propagates error", async () => {
    launchShouldFail = true;

    await expect(spawnInstanceViaController(ENV_ID, USER_ID, "interactive")).rejects.toThrow("launch failed");

    expect(controllerStopCalls).toEqual([INSTANCE_ID]);
    expect(facadeStopCalls).toEqual([INSTANCE_ID]);
    expect(globalInstanceRegistry.size).toBe(0);
  });

  // 成功路径回归：supplement 正常注册且回滚不误触发（两处 stop 均不应被调用）
  test("successful spawn registers supplement without triggering rollback", async () => {
    const instance = await spawnInstanceViaController(ENV_ID, USER_ID, "interactive");

    expect(instance.instanceId).toBe(INSTANCE_ID);
    const sup = globalInstanceRegistry.get(INSTANCE_ID);
    expect(sup?.environmentId).toBe(ENV_ID);
    expect(sup?.userId).toBe(USER_ID);
    expect(sup?.organizationId).toBe("org-1");
    expect(controllerStopCalls).toHaveLength(0);
    expect(facadeStopCalls).toHaveLength(0);
  });
});
