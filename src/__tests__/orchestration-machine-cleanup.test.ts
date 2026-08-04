/**
 * 编排域机器断连清理收敛函数测试（E-P0.1 宿主侧）。
 *
 * 不 import core-bootstrap（被 setup-mocks.ts 全局 mock），只验证新模块与
 * orchestration-bootstrap 单例的幂等/重置语义；"活跃表正确清空"的行为已由
 * packages/orchestration/agent-controller/agent-controller.test.ts 的
 * stopInstancesByMachineId 用例覆盖。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { getOrchestrationController, resetOrchestrationBootstrap } from "../services/orchestration-bootstrap";
import { cleanupOrchestrationInstancesForMachine } from "../services/orchestration-machine-cleanup";

describe("cleanupOrchestrationInstancesForMachine", () => {
  afterEach(() => {
    // 清理单例缓存，避免用例间活跃表状态泄漏
    resetOrchestrationBootstrap();
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
