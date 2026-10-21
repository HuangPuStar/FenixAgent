/** Workflow 自动收尾保持租约与组织隔离；缺少运行代次证明时保守跳过。 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  bindAgentInstanceRuntimeOperations,
  globalInstanceRegistry,
  resetAgentInstanceRuntimeOperations,
} from "@fenix/agent-runtime/server/testing";
import type { CoreRuntimeFacade } from "@fenix/core";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import { cleanupSpawnedInstances } from "../server/services/workflow";
import {
  acquireInstanceLease,
  clearInstanceLeases,
  releaseInstanceLease,
} from "../server/services/workflow/instance-lease";
import { bindStubCoreRuntime, restoreCoreRuntimePort } from "./core-runtime-stub";

const ORG_1 = "org-1";
const ORG_2 = "org-2";

/** core facade：listInstances 恒为空（无 core 快照），stopInstance 静默成功，供三侧收敛检查。 */
const fakeFacade = {
  listInstances: () => [],
  getInstance: () => null,
  stopInstance: async () => {},
} as unknown as CoreRuntimeFacade;

/** 注册一个属于指定 org 的 running supplement（真实注册表单例）。 */
function registerRunningInstance(instanceId: string, environmentId: string, organizationId: string): void {
  globalInstanceRegistry.register(instanceId, {
    userId: "user-1",
    environmentId,
    organizationId,
    spawnSource: "system",
    lastActivityAt: Date.now(),
    relayCount: 0,
    lastRelayDetachedAt: null,
  });
}

describe("cleanupSpawnedInstances", () => {
  beforeEach(() => {
    globalInstanceRegistry.clear();
    clearInstanceLeases();
    resetAllStubs();
    bindStubCoreRuntime(fakeFacade);
    bindAgentInstanceRuntimeOperations({
      async spawnInstance() {
        throw new Error("cleanup must not start a runtime");
      },
      hasActiveInstance: () => false,
      async stopInstance(instanceId) {
        await fakeFacade.stopInstance(instanceId);
        globalInstanceRegistry.unregister(instanceId);
      },
    });
  });

  afterEach(() => {
    globalInstanceRegistry.clear();
    clearInstanceLeases();
    resetAllStubs();
    restoreCoreRuntimePort();
    resetAgentInstanceRuntimeOperations();
  });

  // 幂等：不存在的 instanceId 被 stopInstance 以 ok:false 静默跳过，cleanup 重复执行无害
  test("不存在的 instanceId 静默跳过且不抛错", async () => {
    await expect(cleanupSpawnedInstances(new Set(["inst_missing"]), ORG_1)).resolves.toEqual([]);
  });

  // 多租户隔离：跨 org 清理被 stopInstance 的组织归属校验拦截，实例保持存活
  test("跨组织 cleanup 不停止目标实例", async () => {
    registerRunningInstance("inst_A", "env-1", ORG_1);

    await cleanupSpawnedInstances(new Set(["inst_A"]), ORG_2);

    expect(globalInstanceRegistry.get("inst_A")).toBeDefined();
  });

  // 并发：不同 run 的 cleanup 同时执行互不干扰、均正常 resolve
  test("并发 cleanup 均正常 resolve", async () => {
    await expect(
      Promise.all([
        cleanupSpawnedInstances(new Set(["inst_missing_1"]), ORG_1),
        cleanupSpawnedInstances(new Set(["inst_missing_2"]), ORG_2),
      ]),
    ).resolves.toEqual([[], []]);
  });

  // 自动回收必须持有确认的运行代次，不能仅凭孤儿 supplement 接管未知运行实体。
  test("混合实例集合缺少运行代次证明时保留投影", async () => {
    registerRunningInstance("inst_A", "env-1", ORG_1);
    registerRunningInstance("inst_B", "env-2", ORG_2);

    await cleanupSpawnedInstances(new Set(["inst_missing", "inst_A", "inst_B"]), ORG_2);

    expect(globalInstanceRegistry.get("inst_A")).toBeDefined();
    expect(globalInstanceRegistry.get("inst_B")).toBeDefined();
  });

  // C-P1.1-R：实例仍被其他 run 持有租约时，cleanup 跳过停止并返回 skipped 列表，
  // supplement 保留（实例不被误杀，使用者 execute 不受影响）
  test("实例仍被其他 run 持有租约 → 跳过停止并返回 skipped", async () => {
    registerRunningInstance("inst_A", "env-1", ORG_1);
    acquireInstanceLease("inst_A");

    const skipped = await cleanupSpawnedInstances(new Set(["inst_A"]), ORG_1);

    expect(skipped).toEqual(["inst_A"]);
    expect(globalInstanceRegistry.get("inst_A")).toBeDefined();
  });

  // C-P1.1-R：租约释放后 cleanup 不再跳过（回归"创建者正常清理自己 spawn 的实例"）
  test("租约释放后再次 cleanup 正常尝试停止（返回空 skipped）", async () => {
    registerRunningInstance("inst_A", "env-1", ORG_1);
    acquireInstanceLease("inst_A");
    releaseInstanceLease("inst_A");

    const skipped = await cleanupSpawnedInstances(new Set(["inst_A"]), ORG_1);

    expect(skipped).toEqual([]);
  });

  // C-P1.1-R：多 run 共享时，仅最后一个租约释放前 cleanup 始终跳过
  test("多 run 共享：仅最后一个租约释放前 cleanup 始终跳过", async () => {
    registerRunningInstance("inst_A", "env-1", ORG_1);
    acquireInstanceLease("inst_A");
    acquireInstanceLease("inst_A");

    // 创建者先结束（释放一份租约）→ 使用者仍持有，跳过
    releaseInstanceLease("inst_A");
    expect(await cleanupSpawnedInstances(new Set(["inst_A"]), ORG_1)).toEqual(["inst_A"]);

    // 使用者结束（释放最后一份租约）→ 不再跳过
    releaseInstanceLease("inst_A");
    expect(await cleanupSpawnedInstances(new Set(["inst_A"]), ORG_1)).toEqual([]);
  });
});
