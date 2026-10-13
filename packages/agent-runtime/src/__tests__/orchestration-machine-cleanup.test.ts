/**
 * 编排域机器断连清理收敛函数测试（E-P0.1 宿主侧）。
 *
 * 不 import core-bootstrap（被 setup-mocks.ts 全局 mock），只验证新模块与
 * orchestration-bootstrap 单例的幂等/重置语义；"活跃表正确清空"的行为已由
 * packages/orchestration/agent-controller/agent-controller.test.ts 的
 * stopInstancesByMachineId 用例覆盖。
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { AgentController } from "@fenix/orchestration";
import { getOrchestrationController, resetOrchestrationBootstrap } from "../services/orchestration-bootstrap";
import {
  cleanupOrchestrationInstancesForMachine,
  resetOrchestrationMachineCleanupDeps,
  setOrchestrationMachineCleanupDeps,
} from "../services/orchestration-machine-cleanup";

describe("cleanupOrchestrationInstancesForMachine", () => {
  afterEach(() => {
    // 清理单例缓存，避免用例间活跃表状态泄漏
    resetOrchestrationBootstrap();
    resetOrchestrationMachineCleanupDeps();
  });

  test("活跃表为空时返回 0 且不抛错", () => {
    // 首次调用触发单例构造（纯内存表，无 DB 查询），清理不存在的机器返回 0
    expect(getOrchestrationController()).toBeDefined();
    expect(cleanupOrchestrationInstancesForMachine("m1")).toBe(0);
  });

  test("连续调用幂等：两次调用均返回 0 且无异常", () => {
    expect(cleanupOrchestrationInstancesForMachine("m1")).toBe(0);
    expect(cleanupOrchestrationInstancesForMachine("m1")).toBe(0);
  });

  test("单例重置后仍安全：reset 后重新构造并清理返回 0", () => {
    resetOrchestrationBootstrap();
    expect(cleanupOrchestrationInstancesForMachine("m1")).toBe(0);
    // 重置后单例重新构造，行为与首次一致
    expect(cleanupOrchestrationInstancesForMachine("m1")).toBe(0);
  });
});

// SP-C2：机器幽灵清理必须触发被移除实例的内存 Y.Doc 回收。该路径不经过
// stopInstanceViaController（core 实例与 supplement 已被调用方同步删除，idle
// monitor 按 runtime.listInstances() 迭代也永远看不到这些实例），不在此回收则
// instanceSessions 登记与保留的实时 Doc（断链语义一的保留窗口）永久泄漏。
describe("cleanupOrchestrationInstancesForMachine 实时资源回收接线（SP-C2）", () => {
  /** 构造 stopInstancesByMachineId 返回固定 id 列表的 fake controller */
  const fakeControllerWith = (removedIds: string[]): AgentController =>
    ({ stopInstancesByMachineId: () => removedIds }) as unknown as AgentController;

  afterEach(() => {
    resetOrchestrationMachineCleanupDeps();
  });

  // 每个被移除的幽灵实例都必须触发一次回收（fire-and-forget，调用同步发起）
  test("为每个被移除的幽灵实例触发实时资源回收", () => {
    const reclaimed: string[] = [];
    setOrchestrationMachineCleanupDeps({
      getOrchestrationController: () => fakeControllerWith(["inst-ghost-1", "inst-ghost-2"]),
      reclaimYjsDocs: async (instanceId) => {
        reclaimed.push(instanceId);
      },
    });

    expect(cleanupOrchestrationInstancesForMachine("m1")).toBe(2);
    expect(reclaimed).toEqual(["inst-ghost-1", "inst-ghost-2"]);
  });

  // 无幽灵实例时不产生任何回收调用（幂等重入安全）
  test("无匹配实例时不触发回收", () => {
    const reclaimed: string[] = [];
    setOrchestrationMachineCleanupDeps({
      getOrchestrationController: () => fakeControllerWith([]),
      reclaimYjsDocs: async (instanceId) => {
        reclaimed.push(instanceId);
      },
    });

    expect(cleanupOrchestrationInstancesForMachine("m-none")).toBe(0);
    expect(reclaimed).toEqual([]);
  });

  // 回收失败必须吞错记日志且不阻断机器清理（fire-and-forget 语义）
  test("回收失败仅记录日志不抛错", async () => {
    setOrchestrationMachineCleanupDeps({
      getOrchestrationController: () => fakeControllerWith(["inst-x"]),
      reclaimYjsDocs: async () => {
        throw new Error("reclaim failed");
      },
    });

    expect(() => cleanupOrchestrationInstancesForMachine("m1")).not.toThrow();
    // 等 fire-and-forget 的拒绝 promise 落定，确认异常未逃逸
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
