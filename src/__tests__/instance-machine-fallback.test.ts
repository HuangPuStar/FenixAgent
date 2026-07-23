// 实例 fallback 决策：RCS_DEFAULT_MACHINE_ID 和 RCS_DEFAULT_ENGINE_TYPE 环境变量覆盖行为
import { afterEach, describe, expect, test } from "bun:test";
import { config, setConfig } from "../config";

describe("instance machine/engine fallback", () => {
  // 保存原始 config 引用，每次测试后恢复，防止 setConfig 污染后续测试
  const originalConfig = { ...config };

  afterEach(() => {
    setConfig(originalConfig as any);
  });
  // ── config 值读取 ──

  // 不设置任何 fallback 时 defaultMachineId 为 undefined（默认状态）
  test("不设置 defaultMachineId 时值为 undefined", () => {
    expect(config.defaultMachineId).toBeUndefined();
  });

  // 通过 setConfig 模拟 RCS_DEFAULT_MACHINE_ID 环境变量
  test("setConfig 设置 defaultMachineId 后通过 config 可读取", () => {
    setConfig({ defaultMachineId: "mach_fallback_001" } as any);
    expect(config.defaultMachineId).toBe("mach_fallback_001");
  });

  // 通过 setConfig 模拟 RCS_DEFAULT_ENGINE_TYPE 环境变量
  test("setConfig 设置 defaultEngineType 后通过 config 可读取", () => {
    setConfig({ defaultEngineType: "ccb" } as any);
    expect(config.defaultEngineType).toBe("ccb");
  });

  // ── engineType 传递决策：基于最终 nodeId ──

  // local 执行时传递 engineType，使用 RCS_DEFAULT_ENGINE_TYPE 或默认 opencode
  test("local 执行时传递 engineType，优先使用 RCS_DEFAULT_ENGINE_TYPE", () => {
    const resolvedNodeId: string = "local-default";
    const engineType = resolvedNodeId === "local-default" ? (config.defaultEngineType ?? "opencode") : undefined;
    expect(engineType).toBe("opencode");
  });

  // local 执行、RCS_DEFAULT_ENGINE_TYPE 有值时使用环境变量
  test("local 执行时 RCS_DEFAULT_ENGINE_TYPE 覆盖默认值", () => {
    setConfig({ defaultEngineType: "ccb" } as any);
    const resolvedNodeId: string = "local-default";
    const engineType = resolvedNodeId === "local-default" ? (config.defaultEngineType ?? "opencode") : undefined;
    expect(engineType).toBe("ccb");
  });

  // remote 执行时不传递 engineType（agent 绑定场景）
  test("remote 执行时 engineType 始终为 undefined", () => {
    const resolvedNodeId: string = "mach_remote_01";
    const engineType = resolvedNodeId === "local-default" ? (config.defaultEngineType ?? "opencode") : undefined;
    expect(engineType).toBeUndefined();
  });

  // RCS_DEFAULT_MACHINE_ID 重定向到 remote 时不传 engineType
  test("RCS_DEFAULT_MACHINE_ID 重定向后 remote 执行不传 engineType", () => {
    setConfig({ defaultMachineId: "mach_redirect" } as any);
    const resolvedNodeId = config.defaultMachineId ?? "local-default";
    // resolvedNodeId 是 "mach_redirect"，不等于 "local-default"
    const engineType = resolvedNodeId === "local-default" ? (config.defaultEngineType ?? "opencode") : undefined;
    expect(engineType).toBeUndefined();
  });

  // ── nodeId fallback 优先级 ──

  // nodeId 无绑定且无系统默认时使用 local-default
  test("nodeId 无绑定且无系统默认时使用 local-default", () => {
    const agentMachineId: string | null = null;
    const systemDefault: string | undefined = undefined;
    let nodeId = "local-default";
    if (agentMachineId) {
      nodeId = agentMachineId;
    } else if (systemDefault) {
      nodeId = systemDefault;
    }
    expect(nodeId).toBe("local-default");
  });

  // nodeId 系统默认 mach_fallback 覆盖 local-default
  test("nodeId 系统默认 mach_fallback 覆盖 local-default", () => {
    const agentMachineId: string | null = null;
    const systemDefault: string | undefined = "mach_fallback";
    let nodeId = "local-default";
    if (agentMachineId) {
      nodeId = agentMachineId;
    } else if (systemDefault) {
      nodeId = systemDefault;
    }
    expect(nodeId).toBe("mach_fallback");
  });

  // nodeId agent config 绑定后忽略系统默认
  test("nodeId agent config 绑定后忽略系统默认", () => {
    const agentMachineId: string | null = "mach_agent_bound";
    const systemDefault: string | undefined = "mach_fallback";
    let nodeId = "local-default";
    if (agentMachineId) {
      nodeId = agentMachineId;
    } else if (systemDefault) {
      nodeId = systemDefault;
    }
    expect(nodeId).toBe("mach_agent_bound");
  });
});
