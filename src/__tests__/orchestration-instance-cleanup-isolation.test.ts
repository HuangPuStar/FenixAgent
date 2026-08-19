/**
 * stopInstancesForEnvironments 三侧收集测试。
 *
 * 直接验证 orchestration-instance 的删除前清理边界：候选来源合并、组织隔离、
 * 并发停止与失败后的业务注册表收敛。全部依赖经既有 DI seam 注入，不访问网络、DB 或进程。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CoreRuntimeFacade, RuntimeInstanceSnapshot } from "@fenix/core";
import type { AgentController } from "@fenix/orchestration";
import { globalInstanceRegistry } from "../services/instance-registry";
import {
  resetOrchestrationInstanceDeps,
  setOrchestrationInstanceDeps,
  stopInstancesForEnvironments,
} from "../services/orchestration-instance";
import { resetAllStubs, stubCoreBootstrap } from "../test-utils/helpers";
import type { InstanceSupplement } from "../types/store";

const ORG_1 = "org-1";
const ORG_2 = "org-2";
const ENV_1 = "env-1";
const ENV_2 = "env-2";

let coreSnapshots: RuntimeInstanceSnapshot[] = [];
let controllerInstances: Array<{ instanceId: string; environmentId: string }> = [];
let controllerStopCalls: string[] = [];
let coreStopCalls: string[] = [];
let relayCloseCalls: string[] = [];
let reclaimCalls: string[] = [];
let controllerStopFailure: string | null = null;
let coreStopFailure: string | null = null;
let stopGate: { promise: Promise<void>; resolve: () => void } | null = null;

function makeSupplement(environmentId: string, organizationId: string): InstanceSupplement {
  return {
    userId: "user-1",
    environmentId,
    instanceNumber: 1,
    organizationId,
    spawnSource: "interactive",
    lastActivityAt: Date.now(),
    relayCount: 0,
    lastRelayDetachedAt: null,
  };
}

function makeSnapshot(instanceId: string, environmentId: string, organizationId?: string): RuntimeInstanceSnapshot {
  return {
    instanceId,
    status: "running",
    createdAt: new Date(),
    updatedAt: new Date(),
    launchSpec: { environmentId, organizationId },
  } as RuntimeInstanceSnapshot;
}

const fakeFacade: Pick<CoreRuntimeFacade, "listInstances" | "stopInstance"> = {
  listInstances: () => coreSnapshots,
  stopInstance: async (instanceId: string) => {
    coreStopCalls.push(instanceId);
    if (coreStopFailure === instanceId) throw new Error(`core stop failed: ${instanceId}`);
    if (stopGate) await stopGate.promise;
  },
};

const fakeController: Pick<AgentController, "listInstances" | "stopInstance"> = {
  listInstances: () => controllerInstances,
  stopInstance: async (instanceId: string) => {
    controllerStopCalls.push(instanceId);
    if (controllerStopFailure === instanceId) throw new Error(`controller stop failed: ${instanceId}`);
    controllerInstances = controllerInstances.filter((instance) => instance.instanceId !== instanceId);
  },
};

describe("stopInstancesForEnvironments", () => {
  beforeEach(() => {
    globalInstanceRegistry.clear();
    coreSnapshots = [];
    controllerInstances = [];
    controllerStopCalls = [];
    coreStopCalls = [];
    relayCloseCalls = [];
    reclaimCalls = [];
    controllerStopFailure = null;
    coreStopFailure = null;
    stopGate = null;
    resetAllStubs();
    resetOrchestrationInstanceDeps();
    stubCoreBootstrap({ getCoreRuntime: () => fakeFacade });
    setOrchestrationInstanceDeps({
      getOrchestrationController: () => fakeController as AgentController,
      closeRelayConnectionsForStoppedInstance: async (instanceId) => {
        relayCloseCalls.push(instanceId);
      },
      reclaimYjsDocs: async (instanceId) => {
        reclaimCalls.push(instanceId);
      },
    });
  });

  afterEach(() => {
    globalInstanceRegistry.clear();
    resetOrchestrationInstanceDeps();
    resetAllStubs();
  });

  // 空目标必须直接返回，避免删除流程在无关联环境时访问运行时依赖。
  test("空环境集合直接返回且不访问运行时", async () => {
    await expect(stopInstancesForEnvironments([])).resolves.toEqual([]);
    expect(controllerStopCalls).toEqual([]);
    expect(coreStopCalls).toEqual([]);
  });

  // 三侧来源可能同时看到同一实例；清理必须去重，并保留仅 core 或 controller 可见的孤儿实例。
  test("合并 registry、core 与 controller 候选后每个实例仅停止一次", async () => {
    globalInstanceRegistry.register("inst-shared", makeSupplement(ENV_1, ORG_1));
    coreSnapshots = [makeSnapshot("inst-shared", ENV_1, ORG_1), makeSnapshot("inst-core-orphan", ENV_1, ORG_1)];
    controllerInstances = [
      { instanceId: "inst-shared", environmentId: ENV_1 },
      { instanceId: "inst-controller-orphan", environmentId: ENV_1 },
    ];

    const stopped = await stopInstancesForEnvironments([ENV_1], { organizationId: ORG_1 });

    expect(new Set(stopped)).toEqual(new Set(["inst-shared", "inst-core-orphan"]));
    expect(controllerStopCalls.sort()).toEqual(["inst-core-orphan", "inst-shared"]);
    expect(coreStopCalls.sort()).toEqual(["inst-core-orphan", "inst-shared"]);
    expect(globalInstanceRegistry.get("inst-shared")).toBeUndefined();
  });

  // 带组织约束时只能停止归属明确匹配的实例；外组织和无归属 controller 幽灵必须保守跳过。
  test("组织过滤不会停止其他组织或无归属的实例", async () => {
    globalInstanceRegistry.register("inst-org-1", makeSupplement(ENV_1, ORG_1));
    globalInstanceRegistry.register("inst-org-2", makeSupplement(ENV_1, ORG_2));
    coreSnapshots = [makeSnapshot("inst-core-org-1", ENV_1, ORG_1), makeSnapshot("inst-core-org-2", ENV_1, ORG_2)];
    controllerInstances = [{ instanceId: "inst-unknown-owner", environmentId: ENV_1 }];

    const stopped = await stopInstancesForEnvironments([ENV_1], { organizationId: ORG_1 });

    expect(new Set(stopped)).toEqual(new Set(["inst-org-1", "inst-core-org-1"]));
    expect(globalInstanceRegistry.get("inst-org-2")).toBeDefined();
    expect(controllerStopCalls).not.toContain("inst-unknown-owner");
    expect(coreStopCalls).not.toContain("inst-core-org-2");
  });

  // 多实例停止使用并发收敛；一个实例的慢 core stop 不得阻塞另一个实例进入停止流程。
  test("多个目标并发停止且互不阻塞", async () => {
    globalInstanceRegistry.register("inst-env-1", makeSupplement(ENV_1, ORG_1));
    globalInstanceRegistry.register("inst-env-2", makeSupplement(ENV_2, ORG_1));
    let resolveGate!: () => void;
    stopGate = { promise: new Promise<void>((resolve) => (resolveGate = resolve)), resolve: resolveGate };

    const cleanup = stopInstancesForEnvironments([ENV_1, ENV_2], { organizationId: ORG_1 });
    await Promise.resolve();
    await Promise.resolve();

    expect(new Set(coreStopCalls)).toEqual(new Set(["inst-env-1", "inst-env-2"]));
    resolveGate();
    await expect(cleanup).resolves.toEqual(expect.arrayContaining(["inst-env-1", "inst-env-2"]));
  });

  // 停止任一底层步骤失败仍须继续清理并注销 supplement，避免删除流程留下可复用的脏实例。
  test("停止和后续资源回收报错时仍收敛注册表并继续处理其他实例", async () => {
    globalInstanceRegistry.register("inst-failing", makeSupplement(ENV_1, ORG_1));
    globalInstanceRegistry.register("inst-healthy", makeSupplement(ENV_1, ORG_1));
    controllerStopFailure = "inst-failing";
    coreStopFailure = "inst-failing";
    setOrchestrationInstanceDeps({
      closeRelayConnectionsForStoppedInstance: async (instanceId) => {
        relayCloseCalls.push(instanceId);
        if (instanceId === "inst-failing") throw new Error("relay close failed");
      },
      reclaimYjsDocs: async (instanceId) => {
        reclaimCalls.push(instanceId);
        if (instanceId === "inst-failing") throw new Error("doc reclaim failed");
      },
    });

    await expect(stopInstancesForEnvironments([ENV_1], { organizationId: ORG_1 })).resolves.toEqual(
      expect.arrayContaining(["inst-failing", "inst-healthy"]),
    );

    expect(globalInstanceRegistry.size).toBe(0);
    expect(coreStopCalls.sort()).toEqual(["inst-failing", "inst-healthy"]);
    expect(relayCloseCalls.sort()).toEqual(["inst-failing", "inst-healthy"]);
    expect(reclaimCalls.sort()).toEqual(["inst-failing", "inst-healthy"]);
  });
});
