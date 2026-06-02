import { describe, expect, test } from "bun:test";
import { InstanceRegistry } from "../services/instance-registry";
import type { InstanceSupplement } from "../types/store";

function makeSupplement(overrides: Partial<InstanceSupplement> = {}): InstanceSupplement {
  return {
    userId: "user-1",
    environmentId: "env-1",
    instanceNumber: 1,
    organizationId: "org-1",
    ...overrides,
  };
}

describe("InstanceRegistry", () => {
  // 注册和查询
  test("register + get 返回已注册的补充信息", () => {
    const registry = new InstanceRegistry();
    registry.register("inst-1", makeSupplement());
    const sup = registry.get("inst-1");
    expect(sup).toBeDefined();
    expect(sup!.userId).toBe("user-1");
  });

  // 按环境查询
  test("getByEnvironment 返回同环境的所有实例", () => {
    const registry = new InstanceRegistry();
    registry.register("inst-1", makeSupplement({ environmentId: "env-1", instanceNumber: 1 }));
    registry.register("inst-2", makeSupplement({ environmentId: "env-1", instanceNumber: 2 }));
    registry.register("inst-3", makeSupplement({ environmentId: "env-2", instanceNumber: 1 }));

    const env1 = registry.getByEnvironment("env-1");
    expect(env1).toHaveLength(2);
    const env2 = registry.getByEnvironment("env-2");
    expect(env2).toHaveLength(1);
  });

  // 注销清除条目和索引
  test("unregister 清除条目和 byEnvironment 索引", () => {
    const registry = new InstanceRegistry();
    registry.register("inst-1", makeSupplement());
    registry.unregister("inst-1");

    expect(registry.get("inst-1")).toBeUndefined();
    expect(registry.getByEnvironment("env-1")).toHaveLength(0);
    expect(registry.has("inst-1")).toBe(false);
  });

  // nextInstanceNumber 单调递增
  test("nextInstanceNumber 单调递增", () => {
    const registry = new InstanceRegistry();
    expect(registry.nextInstanceNumber("env-1")).toBe(1);
    expect(registry.nextInstanceNumber("env-1")).toBe(2);
    expect(registry.nextInstanceNumber("env-1")).toBe(3);
  });

  // nextInstanceNumber 与现有实例取最大值
  test("nextInstanceNumber 取 max(counter, 现有实例最大编号) + 1", () => {
    const registry = new InstanceRegistry();
    // 手动注册一个 instanceNumber=5 的实例（绕过 nextInstanceNumber）
    registry.register("inst-1", makeSupplement({ instanceNumber: 5 }));

    // counter 为 0，现有实例最大编号为 5，所以下一个应为 6
    expect(registry.nextInstanceNumber("env-1")).toBe(6);
  });

  // 无实例时 nextInstanceNumber 返回 1
  test("nextInstanceNumber 环境无实例时返回 1", () => {
    const registry = new InstanceRegistry();
    expect(registry.nextInstanceNumber("empty-env")).toBe(1);
  });

  // deleteCounter 仅在无实例时删除
  test("deleteCounter 仅在无残留实例时删除计数器", () => {
    const registry = new InstanceRegistry();
    registry.register("inst-1", makeSupplement({ instanceNumber: 1 }));

    // 调用 nextInstanceNumber 后 counter 推进到 2
    expect(registry.nextInstanceNumber("env-1")).toBe(2);

    // 还有实例，deleteCounter 不删除计数器
    registry.deleteCounter("env-1");
    // counter 仍为 2，max(2, 1) + 1 = 3
    expect(registry.nextInstanceNumber("env-1")).toBe(3);

    // 移除实例后，deleteCounter 删除计数器
    registry.unregister("inst-1");
    registry.deleteCounter("env-1");
    // 计数器已删除，从 0 重新开始
    expect(registry.nextInstanceNumber("env-1")).toBe(1);
  });

  // clear 清空所有数据
  test("clear 清空所有注册数据", () => {
    const registry = new InstanceRegistry();
    registry.register("inst-1", makeSupplement());
    registry.nextInstanceNumber("env-1");
    registry.clear();

    expect(registry.size).toBe(0);
    expect(registry.get("inst-1")).toBeUndefined();
    expect(registry.getByEnvironment("env-1")).toHaveLength(0);
  });

  // reconcile 移除孤儿条目
  test("reconcile 移除 core 中不存在的条目", () => {
    const registry = new InstanceRegistry();
    registry.register("inst-1", makeSupplement());
    registry.register("inst-2", makeSupplement({ environmentId: "env-2" }));

    // core 中只有 inst-1
    registry.reconcile(() => [{ instanceId: "inst-1" }]);

    expect(registry.has("inst-1")).toBe(true);
    expect(registry.has("inst-2")).toBe(false);
    expect(registry.getByEnvironment("env-2")).toHaveLength(0);
  });

  // size 返回正确计数
  test("size 返回已注册实例数", () => {
    const registry = new InstanceRegistry();
    expect(registry.size).toBe(0);
    registry.register("inst-1", makeSupplement());
    expect(registry.size).toBe(1);
    registry.register("inst-2", makeSupplement({ environmentId: "env-2" }));
    expect(registry.size).toBe(2);
  });
});
