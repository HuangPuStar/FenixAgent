import { describe, expect, test } from "bun:test";
import { AgentDetailSchema } from "../schemas/config.schema";
import { AGENT_SETTABLE_FIELDS, validateAgentData } from "../services/config/agent-config";
import { ENGINE_TYPES } from "../services/config/types";

describe("ENGINE_TYPES 常量", () => {
  test("包含 opencode、ccb 和 claude-code", () => {
    expect(ENGINE_TYPES).toEqual(["opencode", "ccb", "claude-code"]);
  });

  test("是 readonly 元组", () => {
    expect(ENGINE_TYPES.length).toBe(3);
    expect(ENGINE_TYPES[0]).toBe("opencode");
    expect(ENGINE_TYPES[1]).toBe("ccb");
    expect(ENGINE_TYPES[2]).toBe("claude-code");
  });
});

describe("AGENT_SETTABLE_FIELDS", () => {
  test("包含 engineType", () => {
    expect(AGENT_SETTABLE_FIELDS.includes("engineType")).toBe(true);
  });
});

describe("validateAgentData — engineType", () => {
  test('合法值 "opencode" 通过校验', () => {
    expect(validateAgentData({ engineType: "opencode" })).toBeNull();
  });

  test('合法值 "ccb" 通过校验', () => {
    expect(validateAgentData({ engineType: "ccb" })).toBeNull();
  });

  test('合法值 "claude-code" 通过校验', () => {
    expect(validateAgentData({ engineType: "claude-code" })).toBeNull();
  });

  test("非法值被拒绝", () => {
    expect(validateAgentData({ engineType: "unknown-engine" })).toBe("INVALID_ENGINE_TYPE");
  });

  test("类型错误（数字）被拒绝", () => {
    expect(validateAgentData({ engineType: 123 })).toBe("INVALID_ENGINE_TYPE");
  });

  test("undefined 时通过校验（向后兼容）", () => {
    expect(validateAgentData({})).toBeNull();
  });

  test("null 时通过校验（向后兼容）", () => {
    expect(validateAgentData({ engineType: null })).toBeNull();
  });
});

describe("AgentDetailSchema — engineType", () => {
  test("支持 engineType 字段", () => {
    const result = AgentDetailSchema.safeParse({
      name: "test",
      builtIn: false,
      model: null,
      modelId: null,
      prompt: null,
      description: null,
      knowledge: null,
      engineType: "opencode",
    });
    expect(result.success).toBe(true);
  });

  test("engineType 为 null 时通过", () => {
    const result = AgentDetailSchema.safeParse({
      name: "test",
      builtIn: false,
      model: null,
      modelId: null,
      prompt: null,
      description: null,
      knowledge: null,
      engineType: null,
    });
    expect(result.success).toBe(true);
  });
});
