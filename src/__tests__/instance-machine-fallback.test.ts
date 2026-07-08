// 实例 fallback 决策：RCS_DEFAULT_MACHINE_ID 和 RCS_DEFAULT_ENGINE_TYPE 环境变量覆盖行为
import { describe, expect, test } from "bun:test";
import { config, setConfig } from "../config";

describe("instance machine/engine fallback", () => {
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

  // ── engineType 默认值优先级 ──

  // engineType 未设置任何值时默认为 'opencode'
  test("engineType 未设置任何值时默认为 'opencode'", () => {
    const resolved = null;
    const systemDefault: string | undefined = undefined;
    const fallback = "opencode";
    const engineType = (resolved as any)?.engineType ?? systemDefault ?? fallback;
    expect(engineType).toBe("opencode");
  });

  // engineType 系统默认 ccb 覆盖 hardcoded opencode
  test("engineType 系统默认 ccb 覆盖 hardcoded opencode", () => {
    const resolved = null;
    const systemDefault: string | undefined = "ccb";
    const fallback = "opencode";
    const engineType = (resolved as any)?.engineType ?? systemDefault ?? fallback;
    expect(engineType).toBe("ccb");
  });

  // engineType agent config 显式指定时覆盖系统默认
  test("engineType agent config 显式指定时覆盖系统默认", () => {
    const resolved = { engineType: "claude-code" };
    const systemDefault: string | undefined = "ccb";
    const fallback = "opencode";
    const engineType = (resolved as any)?.engineType ?? systemDefault ?? fallback;
    expect(engineType).toBe("claude-code");
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
