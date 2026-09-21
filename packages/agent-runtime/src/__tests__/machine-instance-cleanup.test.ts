/**
 * 机器维度实例收敛（`AgentRuntimePort.cleanupMachineInstances` 的实现）测试。
 *
 * 覆盖本函数自己负责的两件事：①只删目标机器的 core 实例、且每个删除都配对注销实例登记表；
 * ②core 侧已无实例时仍要收敛编排域活跃表（调用方是宿主的机器重连/断连/沙盒释放路径，
 * 后者不经 ACP handler，E-P0.1）。core 单例经宿主 preload 的 `stubCoreBootstrap` 注入假 facade，
 * 与包内其它用例的接缝一致。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CoreRuntimeFacade } from "@fenix/core";
import type { AgentController } from "@fenix/orchestration";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import { stubCoreBootstrap } from "@server/test-utils/stubs/module-stubs";
import { globalInstanceRegistry } from "../services/instance-registry";
import { convergeMachineInstances } from "../services/machine-instance-cleanup";
import {
  resetOrchestrationMachineCleanupDeps,
  setOrchestrationMachineCleanupDeps,
} from "../services/orchestration-machine-cleanup";

/** 只实现收敛用到的两个动词的假 facade：实例列表可控，删除记录到数组。 */
function fakeFacadeWith(instances: Array<{ instanceId: string; nodeId: string }>): {
  facade: CoreRuntimeFacade;
  deleted: string[];
} {
  const deleted: string[] = [];
  const facade = {
    listInstances: () => instances,
    deleteInstance: (instanceId: string) => {
      deleted.push(instanceId);
      return true;
    },
  } as unknown as CoreRuntimeFacade;
  return { facade, deleted };
}

/** 登记表条目只用于断言「被删实例的补充信息一并注销」，字段取最小可用集。 */
function registerSupplement(instanceId: string, environmentId: string): void {
  globalInstanceRegistry.register(instanceId, {
    environmentId,
    agentConfigId: null,
    userId: "user-1",
    organizationId: "org-1",
    instanceName: instanceId,
    relayCount: 0,
    lastActivityAt: Date.now(),
    lastRelayDetachedAt: null,
    createdAt: Date.now(),
  } as Parameters<typeof globalInstanceRegistry.register>[1]);
}

describe("convergeMachineInstances", () => {
  beforeEach(() => {
    globalInstanceRegistry.clear();
  });

  afterEach(() => {
    // 机器清理函数经编排域收敛无条件调用编排单例，用例结束必须复位，避免活跃表状态跨文件泄漏
    resetOrchestrationMachineCleanupDeps();
    globalInstanceRegistry.clear();
    resetAllStubs();
  });

  // 只删目标机器的实例：别的机器上的实例与登记表条目必须原样保留，否则一次重连会连带清掉
  // 其它机器的运行时（并发额度与 relay 语义都会被误伤）
  test("只收敛目标机器的实例，其余机器的实例与登记表条目不受影响", () => {
    const { facade, deleted } = fakeFacadeWith([
      { instanceId: "inst-a", nodeId: "m1" },
      { instanceId: "inst-b", nodeId: "m1" },
      { instanceId: "inst-c", nodeId: "m2" },
    ]);
    stubCoreBootstrap({ getCoreRuntime: () => facade });
    registerSupplement("inst-a", "env-1");
    registerSupplement("inst-c", "env-1");

    expect(convergeMachineInstances("m1")).toBe(2);

    expect(deleted).toEqual(["inst-a", "inst-b"]);
    // 登记表条目随删除配对注销：漏掉会让该实例永久计入环境并发额度
    expect(globalInstanceRegistry.has("inst-a")).toBe(false);
    expect(globalInstanceRegistry.has("inst-c")).toBe(true);
  });

  // core 侧已无实例（例如 idle 回收先一步收尾）时仍要清理编排域活跃表，返回 0 且不抛错：
  // 这是沙盒释放路径唯一能收敛幽灵实例的时机
  test("core 实例为空时仍收敛编排域并返回 0", () => {
    const { facade } = fakeFacadeWith([]);
    stubCoreBootstrap({ getCoreRuntime: () => facade });
    const reclaimed: string[] = [];
    setOrchestrationMachineCleanupDeps({
      getOrchestrationController: () =>
        ({ stopInstancesByMachineId: () => ["inst-ghost"] }) as unknown as AgentController,
      reclaimYjsDocs: async (instanceId) => {
        reclaimed.push(instanceId);
      },
    });

    expect(convergeMachineInstances("m-ghost")).toBe(0);
    expect(reclaimed).toEqual(["inst-ghost"]);
  });

  // 无匹配实例且活跃表为空：幂等重入安全（重连分支每次都会调用本函数）
  test("无匹配实例时幂等返回 0", () => {
    const { facade } = fakeFacadeWith([{ instanceId: "inst-c", nodeId: "m2" }]);
    stubCoreBootstrap({ getCoreRuntime: () => facade });

    expect(convergeMachineInstances("m1")).toBe(0);
    expect(convergeMachineInstances("m1")).toBe(0);
  });
});
