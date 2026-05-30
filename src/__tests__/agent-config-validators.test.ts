import { describe, expect, it } from "bun:test";

// 测试 agent-config.ts 的 AGENT_SETTABLE_FIELDS 和 validateAgentData 边界

const { AGENT_SETTABLE_FIELDS, validateAgentData, isBuiltInAgent, toolsToPermission } = await import(
  "../services/config/agent-config"
);

// ── AGENT_SETTABLE_FIELDS ──

describe("AGENT_SETTABLE_FIELDS", () => {
  // 确认已知字段都包含在列表中
  it("包含所���期望的可设置字段", () => {
    const expected = [
      "model",
      "prompt",
      "steps",
      "mode",
      "permission",
      "variant",
      "temperature",
      "topP",
      "top_p",
      "disable",
      "hidden",
      "color",
      "description",
      "knowledge",
      "machineId",
    ];
    for (const field of expected) {
      expect((AGENT_SETTABLE_FIELDS as readonly string[]).includes(field)).toBe(true);
    }
  });
});

// ── validateAgentData ──

describe("validateAgentData", () => {
  // 合法输入通过
  it("合法数据返回 null", () => {
    expect(validateAgentData({ mode: "primary", steps: 10 })).toBeNull();
    expect(validateAgentData({ temperature: 0.7, topP: 0.9 })).toBeNull();
    expect(validateAgentData({})).toBeNull();
  });

  // 无效 mode
  it("拒绝无效 mode", () => {
    expect(validateAgentData({ mode: "invalid" })).toBe("INVALID_MODE");
  });

  // 无效 steps
  it("拒绝无效 steps", () => {
    expect(validateAgentData({ steps: 0 })).toBe("INVALID_STEPS");
    expect(validateAgentData({ steps: 201 })).toBe("INVALID_STEPS");
    expect(validateAgentData({ steps: 1.5 })).toBe("INVALID_STEPS");
  });

  // steps 边界值
  it("接受 steps 边界值 1 和 200", () => {
    expect(validateAgentData({ steps: 1 })).toBeNull();
    expect(validateAgentData({ steps: 200 })).toBeNull();
  });

  // temperature 边界
  it("接受 temperature 0 和 2", () => {
    expect(validateAgentData({ temperature: 0 })).toBeNull();
    expect(validateAgentData({ temperature: 2 })).toBeNull();
  });

  it("拒绝超范围 temperature", () => {
    expect(validateAgentData({ temperature: -0.1 })).toBe("INVALID_TEMPERATURE");
    expect(validateAgentData({ temperature: 2.1 })).toBe("INVALID_TEMPERATURE");
  });

  // topP 边界（R34 修复后 validateAgentData 同时校验 topP 和 top_p）
  it("接受 topP 0 和 1", () => {
    expect(validateAgentData({ topP: 0 })).toBeNull();
    expect(validateAgentData({ topP: 1 })).toBeNull();
  });

  it("拒绝超范围 topP", () => {
    expect(validateAgentData({ topP: -0.1 })).toBe("INVALID_TOP_P");
    expect(validateAgentData({ topP: 1.1 })).toBe("INVALID_TOP_P");
  });

  it("拒绝超范围 top_p（snake_case）", () => {
    expect(validateAgentData({ top_p: -0.1 })).toBe("INVALID_TOP_P");
    expect(validateAgentData({ top_p: 1.1 })).toBe("INVALID_TOP_P");
  });

  // color 校验
  it("接受合法颜色值", () => {
    expect(validateAgentData({ color: "#FF00FF" })).toBeNull();
    expect(validateAgentData({ color: "primary" })).toBeNull();
    expect(validateAgentData({ color: "success" })).toBeNull();
  });

  it("拒绝非法颜色值", () => {
    expect(validateAgentData({ color: "not-a-color" })).toBe("INVALID_COLOR");
    expect(validateAgentData({ color: 123 })).toBe("INVALID_COLOR");
    expect(validateAgentData({ color: "#FFF" })).toBe("INVALID_COLOR");
  });

  // permission 校验
  it("接受合法 permission", () => {
    expect(validateAgentData({ permission: { bash: "allow" } })).toBeNull();
    expect(validateAgentData({ permission: null })).toBeNull();
  });

  it("拒绝非法 permission", () => {
    expect(validateAgentData({ permission: "ask" })).toBe("INVALID_PERMISSION");
    expect(validateAgentData({ permission: [1, 2] })).toBe("INVALID_PERMISSION");
  });

  // 非字符串 mode 不触发 mode 校验
  it("非字符串 mode 不触发校验", () => {
    expect(validateAgentData({ mode: 123 })).toBeNull();
  });

  // 非数字 steps 不触发 steps 校验
  it("非数字 steps 不触发校验", () => {
    expect(validateAgentData({ steps: "10" })).toBeNull();
  });
});

// ── isBuiltInAgent ──

describe("isBuiltInAgent", () => {
  it("识别内置 agent", () => {
    expect(isBuiltInAgent("build")).toBe(true);
    expect(isBuiltInAgent("plan")).toBe(true);
    expect(isBuiltInAgent("general")).toBe(true);
    expect(isBuiltInAgent("explore")).toBe(true);
    expect(isBuiltInAgent("title")).toBe(true);
    expect(isBuiltInAgent("summary")).toBe(true);
    expect(isBuiltInAgent("compaction")).toBe(true);
  });

  it("拒绝非内置 agent", () => {
    expect(isBuiltInAgent("custom")).toBe(false);
    expect(isBuiltInAgent("Build")).toBe(false);
    expect(isBuiltInAgent("")).toBe(false);
  });
});

// ── toolsToPermission ──

describe("toolsToPermission", () => {
  it("将布尔 tools 转为 permission 三态", () => {
    const result = toolsToPermission({ bash: true, edit: false });
    expect(result).toEqual({ bash: "allow", edit: "deny" });
  });

  it("空对象返回空结果", () => {
    expect(toolsToPermission({})).toEqual({});
  });
});
