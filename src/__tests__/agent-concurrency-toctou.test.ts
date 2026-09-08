/**
 * 用户级/总并发检查 TOCTOU 修复测试（A-P2.1）。
 *
 * 背景：spawnInstanceViaController 原先在函数首行做只读并发检查
 * （assertAgentConcurrencyAvailable），之后到 registerSupplement 注册之间隔着
 * controller.spawnInstance、LaunchSpec 构建、core launch 等多个 await 窗口，
 * 期间新实例在用户级/定时级统计中完全不可见，N 个并发 spawn 可全部通过检查
 * 造成同用户超发 1+。修复：检查与 in-flight 预留合并为同一同步段
 * （beginSpawnReservation），统计函数把未释放的预留计入各桶，finally 兜底释放。
 *
 * 注入方式（禁 mock.module，全部用既有 seam，结构与
 * orchestration-instance-rollback.test.ts 一致）：
 *   - setOrchestrationInstanceDeps：覆盖 environmentRepo /
 *     getOrchestrationController / getOrchestrationLaunchSpecBuilder；
 *   - 保留真实 buildAgentLaunchSpecForCore（无 agentConfigId 环境走 buildBasicLaunchSpec
 *     分支，需 stubDb 提供 provider/model 行）；
 *   - stubCoreBootstrap("getCoreRuntime") 注入假 facade：launchInstance 挂在可控
 *     deferred（launchGate）上模拟慢启动窗口，listInstances 动态返回已 launch 的
 *     实例快照（与真实 core 快照语义一致）。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CoreRuntimeFacade, RuntimeInstanceSnapshot } from "@fenix/core";
import type { AgentController, Instance, LaunchSpec, LaunchSpecBuilder } from "@fenix/orchestration";
import { config, setConfig } from "../config";
import { provider } from "../db/schema";
import type { EnvironmentRecord, IEnvironmentRepo } from "../repositories/environment";
import {
  beginSpawnReservation,
  getActiveAgentCount,
  getActiveScheduledAgentCount,
  getActiveUserAgentCount,
  getPendingSpawnReservations,
  releaseSpawnReservation,
  resetAgentConcurrencyDeps,
} from "../services/agent-concurrency";
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

/** 可控 deferred：手动 resolve，模拟 launch 挂起窗口。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 轮询等待条件成立（默认 2s 超时），用于等待异步 spawn 推进到指定阶段。 */
async function waitUntil(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** 模拟 core 实例快照：仅需 status 参与并发统计。 */
function makeSnapshot(instanceId: string): RuntimeInstanceSnapshot {
  return {
    instanceId,
    status: "running",
    createdAt: now,
    errorMessage: undefined,
    pluginMetadata: {},
  } as unknown as RuntimeInstanceSnapshot;
}

/** launchInstance 挂起闸门：null 时立即执行，非 null 时等待 resolve（模拟慢启动窗口）。 */
let launchGate: ReturnType<typeof deferred<void>> | null = null;
/** launchInstance 调用次数：用于确认 spawn 已推进到 launch 阶段并挂起。 */
let launchCalls = 0;
/** 为 true 时 facade.launchInstance 抛错（launch 失败释放预留回归用）。 */
let launchShouldFail = false;
/** 为 true 时 controller.spawnInstance 抛错（controller 阶段失败释放预留回归用）。 */
let controllerShouldFail = false;
/** 已 launch 的实例快照：模拟 core listInstances 的运行时快照。 */
const launchedInstances: RuntimeInstanceSnapshot[] = [];

const fakeController = {
  spawnInstance: async (_envId: string, _userId: string) => {
    if (controllerShouldFail) throw new Error("controller spawn failed");
    // machineId 为 local-default：走本地 launch 分支，避免远程节点依赖
    return {
      instanceId: INSTANCE_ID,
      environmentId: ENV_ID,
      userId: USER_ID,
      machineId: "local-default",
    } as unknown as Instance;
  },
  stopInstance: async () => {},
} as unknown as AgentController;

const fakeLaunchSpecBuilder = {
  build: async (_envId: string, _userId: string) =>
    ({ environmentId: ENV_ID, userId: USER_ID }) as unknown as LaunchSpec,
} as unknown as LaunchSpecBuilder;

const fakeEnvironmentRepo = {
  getById: async (_id: string) => {
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
    launchCalls += 1;
    // 挂起在闸门上：模拟 launch 慢启动窗口（测试用 resolve 推进）
    await launchGate?.promise;
    if (launchShouldFail) throw new Error("launch failed");
    launchedInstances.push(makeSnapshot(INSTANCE_ID));
  },
  stopInstance: async (instanceId: string) => {
    const index = launchedInstances.findIndex((snapshot) => snapshot.instanceId === instanceId);
    if (index >= 0) launchedInstances.splice(index, 1);
  },
  listInstances: () => launchedInstances,
} as unknown as CoreRuntimeFacade;

describe("spawn concurrency TOCTOU (A-P2.1)", () => {
  beforeEach(() => {
    globalInstanceRegistry.clear();
    resetOrchestrationInstanceDeps();
    // 顺带清空 in-flight 预留集合，保证用例间隔离
    resetAgentConcurrencyDeps();
    setConfig({
      agentMaxConcurrency: undefined,
      userAgentMaxConcurrency: undefined,
      scheduledAgentMaxConcurrency: undefined,
    });
    launchGate = null;
    launchCalls = 0;
    launchShouldFail = false;
    controllerShouldFail = false;
    launchedInstances.length = 0;
    stubCoreBootstrap({ getCoreRuntime: () => fakeFacade });
    // buildBasicLaunchSpec 的 resolveFirstReadableModelConfig 需要 provider/model 行；
    // 查询结构（where → orderBy，model 查询多一层 limit）与 rollback 测试一致
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
    resetAgentConcurrencyDeps();
    resetAllStubs();
    globalInstanceRegistry.clear();
    setConfig(originalConfig);
  });

  // 用户级并发窗口回归：launch 挂起（实例尚未在 core/supplement 可见）时，
  // 第二个同用户 spawn 必须被预留计数拒绝；launch 完成后统计无缝切换为正式实例，
  // 第三个 spawn 仍被拒绝（不得因预留释放而超发）
  test("user concurrency window: in-flight reservation blocks second spawn and stays blocked after handoff", async () => {
    setConfig({ userAgentMaxConcurrency: 1 });
    launchGate = deferred<void>();

    const p1 = spawnInstanceViaController(ENV_ID, USER_ID, "interactive", { instanceUid: "inst_test_concurrency" });
    await waitUntil(() => launchCalls === 1);

    await expect(
      spawnInstanceViaController(ENV_ID, USER_ID, "interactive", { instanceUid: "inst_test_concurrency" }),
    ).rejects.toMatchObject({
      code: "USER_AGENT_CONCURRENCY_LIMIT_REACHED",
      statusCode: 429,
    });

    // 推进 launch：p1 完成 supplement 注册后释放预留
    launchGate.resolve();
    await expect(p1).resolves.toMatchObject({ instanceId: INSTANCE_ID });
    expect(globalInstanceRegistry.get(INSTANCE_ID)).toBeDefined();

    // 统计已从预留无缝切换为正式实例（supplement + core 快照），额度仍被占用
    await expect(
      spawnInstanceViaController(ENV_ID, USER_ID, "interactive", { instanceUid: "inst_test_concurrency" }),
    ).rejects.toMatchObject({
      code: "USER_AGENT_CONCURRENCY_LIMIT_REACHED",
      statusCode: 429,
    });
  });

  // 总并发窗口回归：agentMaxConcurrency 限额在 launch 挂起窗口内同样对第二个
  // spawn 生效（预留计入总并发桶），launch 完成后仍保持占用
  test("total concurrency window: in-flight reservation counts toward total limit", async () => {
    setConfig({ agentMaxConcurrency: 1 });
    launchGate = deferred<void>();

    const p1 = spawnInstanceViaController(ENV_ID, USER_ID, "interactive", { instanceUid: "inst_test_concurrency" });
    await waitUntil(() => launchCalls === 1);

    await expect(
      spawnInstanceViaController(ENV_ID, USER_ID, "interactive", { instanceUid: "inst_test_concurrency" }),
    ).rejects.toMatchObject({
      code: "AGENT_CONCURRENCY_LIMIT_REACHED",
      statusCode: 429,
    });

    launchGate.resolve();
    await expect(p1).resolves.toMatchObject({ instanceId: INSTANCE_ID });

    await expect(
      spawnInstanceViaController(ENV_ID, USER_ID, "interactive", { instanceUid: "inst_test_concurrency" }),
    ).rejects.toMatchObject({
      code: "AGENT_CONCURRENCY_LIMIT_REACHED",
      statusCode: 429,
    });
  });

  // launch 失败路径：预留必须随 finally 释放，否则额度被永久占用，
  // 同一用户后续 spawn 永远被拒
  test("launch failure releases reservation and does not permanently consume quota", async () => {
    setConfig({ userAgentMaxConcurrency: 1 });
    launchShouldFail = true;

    await expect(
      spawnInstanceViaController(ENV_ID, USER_ID, "interactive", { instanceUid: "inst_test_concurrency" }),
    ).rejects.toThrow("launch failed");
    expect(getPendingSpawnReservations().size).toBe(0);

    launchShouldFail = false;
    await expect(
      spawnInstanceViaController(ENV_ID, USER_ID, "interactive", { instanceUid: "inst_test_concurrency" }),
    ).resolves.toMatchObject({
      instanceId: INSTANCE_ID,
    });
  });

  // controller.spawnInstance 抛错路径（环境校验/环境级并发超限）：原 try 外的
  // 失败点移入 try 后，预留必须经 finally 释放
  test("controller spawn failure releases reservation", async () => {
    setConfig({ userAgentMaxConcurrency: 1 });
    controllerShouldFail = true;

    await expect(
      spawnInstanceViaController(ENV_ID, USER_ID, "interactive", { instanceUid: "inst_test_concurrency" }),
    ).rejects.toThrow("controller spawn failed");
    expect(getPendingSpawnReservations().size).toBe(0);
    expect(launchCalls).toBe(0);
  });

  // 预留计入各统计桶（总/用户/定时）且按来源归属正确；释放幂等，重复释放无副作用
  test("reservation counts toward every bucket and release is idempotent", () => {
    const reservation = beginSpawnReservation(USER_ID, "scheduled");

    expect(getActiveAgentCount()).toBe(1);
    expect(getActiveUserAgentCount(USER_ID)).toBe(1);
    expect(getActiveUserAgentCount("user-2")).toBe(0);
    expect(getActiveScheduledAgentCount()).toBe(1);

    releaseSpawnReservation(reservation);
    expect(getActiveAgentCount()).toBe(0);
    expect(getActiveUserAgentCount(USER_ID)).toBe(0);
    expect(getActiveScheduledAgentCount()).toBe(0);

    // 幂等：重复释放无效果，不影响其他预留
    releaseSpawnReservation(reservation);
    expect(getPendingSpawnReservations().size).toBe(0);

    // 非 scheduled 来源不进入定时桶，其他用户的预留不进入本用户桶
    const interactive = beginSpawnReservation("user-2", "interactive");
    expect(getActiveAgentCount()).toBe(1);
    expect(getActiveUserAgentCount(USER_ID)).toBe(0);
    expect(getActiveScheduledAgentCount()).toBe(0);
    releaseSpawnReservation(interactive);
  });
});
