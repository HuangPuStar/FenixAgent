import { describe, expect, test } from "bun:test";
import { machine, sandboxInstance, sandboxPool } from "../db/schema";

describe("sandbox schema", () => {
  // 沙盒实例必须保存稳定的 Machine 身份，供 Provider 创建前注入运行时配置。
  test("defines machine_id on sandbox instances", () => {
    expect(sandboxInstance.machineId.name).toBe("machine_id");
  });

  // 资源池必须保存 Provider 扩展配置，避免把底层参数写入连接层。
  test("defines provider extra configuration on sandbox pools", () => {
    expect(sandboxPool.extra.name).toBe("extra");
  });

  // 机器类型用于让管理面默认隐藏系统托管的 Sandbox 节点。
  test("defines a machine type column", () => {
    expect(machine.type.name).toBe("type");
  });
});
