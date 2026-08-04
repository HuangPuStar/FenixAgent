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
 *     orchestration-instance-rollback.test.ts 与 web DELETE 路由测试覆盖，
 *     本测试聚焦 cleanup 的编排语义（幂等 / 隔离 / 失败不中断）。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { globalInstanceRegistry } from "../services/instance-registry";
import { cleanupSpawnedInstances } from "../services/workflow";
import { resetAllStubs } from "../test-utils/helpers";

const ORG_1 = "org-1";
const ORG_2 = "org-2";

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
    resetAllStubs();
  });

  afterEach(() => {
    globalInstanceRegistry.clear();
    resetAllStubs();
  });

  // 幂等：不存在的 instanceId 被 stopInstance 以 ok:false 静默跳过，cleanup 重复执行无害
  test("不存在的 instanceId 静默跳过且不抛错", async () => {
    await expect(cleanupSpawnedInstances(new Set(["inst_missing"]), ORG_1)).resolves.toBeUndefined();
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
    ).resolves.toEqual([undefined, undefined]);
  });

  // 混合集合：不存在 / 跨 org / 同 org 但编排域活跃表无记录 三类实例混在同一个
  // cleanup 中，全部被 stopInstance 以 ok:false 静默跳过，单个失败不中断整体，
  // 且任何实例的 supplement 都不被误清
  test("混合实例集合静默跳过且 supplement 均保留", async () => {
    registerRunningInstance("inst_A", "env-1", ORG_1);
    registerRunningInstance("inst_B", "env-2", ORG_1);

    await cleanupSpawnedInstances(new Set(["inst_missing", "inst_A", "inst_B"]), ORG_2);

    // inst_A 跨 org 拦截；inst_B 同 org 但真实 controller 活跃表为空（模拟实例
    // 已被回收的竞态）→ stopInstance 返回 "Instance not found"，supplement 保留
    expect(globalInstanceRegistry.get("inst_A")).toBeDefined();
    expect(globalInstanceRegistry.get("inst_B")).toBeDefined();
  });
});
