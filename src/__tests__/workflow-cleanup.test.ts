/**
 * cleanupSpawnedInstances 测试（C-P1.1）。
 *
 * 背景：原 cleanupSpawnedEnvironments 按 envId 停掉环境内全部运行实例，误杀并发
 * run 与其他来源（用户交互）实例；修复后按 instanceId 精确停止本次 run spawn 的
 * 实例（agent-chat-transport 在 ensureRunning 返回 status === "spawned" 时记录
 * instance.id）。
 *
 * 注入方式（禁 mock.module，复用既有 seam）：
 *   - globalInstanceRegistry 为真实单例，beforeEach 清空、用例内注册 supplement；
 *   - services/instance 模块保持真实（stopInstance 的组织归属校验 / controller
 *     活跃表校验 / 幂等语义正是本测试的断言对象）；
 *   - getOrchestrationController 为模块级绑定且无注入 seam，此处使用真实单例
 *     （AgentController 纯内存、构造不查 DB）；stopInstance 的"成功停止"链路
 *     （controller.stopInstance + core stopInstance + supplement 清理）已由
 *     orchestration-instance-rollback.test.ts 与 web DELETE 路由测试
 *     （instances-delete-idempotent.test.ts）覆盖，本测试聚焦 cleanup 的编排语义
 *     （幂等 / 隔离 / 失败不中断）。
 *   - stopInstance 自 AE-P2.1 起读取 getCoreRuntime().listInstances() 做三侧收敛，
 *     core-bootstrap 未配置 stub 时返回 undefined 会 TypeError，故此处必须
 *     stubCoreBootstrap 注入空 listInstances 的假 facade；同 org 但活跃表无记录的
 *     实例会被幂等收敛清理（不再返回 "Instance not found" 保留 supplement）。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { globalInstanceRegistry } from "../services/instance-registry";
import { cleanupSpawnedInstances } from "../services/workflow";
import { acquireInstanceLease, clearInstanceLeases, releaseInstanceLease } from "../services/workflow/instance-lease";
import { resetAllStubs, stubCoreBootstrap } from "../test-utils/helpers";

const ORG_1 = "org-1";
const ORG_2 = "org-2";

/** core facade：listInstances 恒为空（无 core 快照），stopInstance 静默成功，供三侧收敛检查。 */
const fakeFacade = {
  listInstances: () => [],
  stopInstance: async () => {},
};

/** 注册一个属于指定 org 的 running supplement（真实注册表单例）。 */
function registerRunningInstance(instanceId: string, environmentId: string, organizationId: string): void {
  globalInstanceRegistry.register(instanceId, {
    userId: "user-1",
    environmentId,
    instanceNumber: 1,
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
    stubCoreBootstrap({ getCoreRuntime: () => fakeFacade });
  });

  afterEach(() => {
    globalInstanceRegistry.clear();
    clearInstanceLeases();
    resetAllStubs();
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

  // 混合集合：不存在 / 跨 org / 同 org 但编排域活跃表无记录 三类实例混在同一个
  // cleanup 中：不存在实例与跨 org 实例被 stopInstance 以 ok:false 静默跳过，
  // 同 org 无痕实例被幂等收敛清理（AE-P2.1 语义），单个失败不中断整体
  test("混合实例集合：跨组织实例保留、同组织无痕实例被收敛清理", async () => {
    registerRunningInstance("inst_A", "env-1", ORG_1);
    registerRunningInstance("inst_B", "env-2", ORG_2);

    await cleanupSpawnedInstances(new Set(["inst_missing", "inst_A", "inst_B"]), ORG_2);

    // inst_A 跨 org 拦截保留；inst_B 同 org 但真实 controller 活跃表为空（模拟实例
    // 已被回收的竞态）→ stopInstance 幂等收敛停止并清理 supplement（不再保留）
    expect(globalInstanceRegistry.get("inst_A")).toBeDefined();
    expect(globalInstanceRegistry.get("inst_B")).toBeUndefined();
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
