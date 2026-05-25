import { describe, expect, test } from "bun:test";
import {
  AGENT_SETTABLE_FIELDS,
  isBuiltInAgent,
  normalizeKnowledgeConfig,
  toolsToPermission,
  validateAgentData,
} from "../../services/config/agent-config";

describe("validateAgentData", () => {
  // 有效数据返回 null
  test("有效数据返回 null", () => {
    expect(validateAgentData({ model: "gpt-4o", steps: 50, mode: "primary" })).toBeNull();
  });

  // 无效 mode
  test("无效 mode", () => {
    expect(validateAgentData({ mode: "invalid" })).toBe("INVALID_MODE");
  });

  // 无效 steps — 过大
  test("无效 steps — 过大", () => {
    expect(validateAgentData({ steps: 999 })).toBe("INVALID_STEPS");
  });

  // 无效 steps — 非整数
  test("无效 steps — 非整数", () => {
    expect(validateAgentData({ steps: 1.5 })).toBe("INVALID_STEPS");
  });

  // 无效 temperature — 负数
  test("无效 temperature — 负数", () => {
    expect(validateAgentData({ temperature: -1 })).toBe("INVALID_TEMPERATURE");
  });

  // 有效 temperature 边界 0
  test("有效 temperature 边界 0", () => {
    expect(validateAgentData({ temperature: 0 })).toBeNull();
  });

  // 有效 temperature 边界 2
  test("有效 temperature 边界 2", () => {
    expect(validateAgentData({ temperature: 2 })).toBeNull();
  });

  // 无效 top_p
  test("无效 top_p", () => {
    expect(validateAgentData({ top_p: 1.5 })).toBe("INVALID_TOP_P");
  });

  // 无效 color — 非法字符串
  test("无效 color — 非法字符串", () => {
    expect(validateAgentData({ color: "notacolor" })).toBe("INVALID_COLOR");
  });

  // 有效 color — hex
  test("有效 color — hex", () => {
    expect(validateAgentData({ color: "#FF5500" })).toBeNull();
  });

  // 有效 color — 预设
  test("有效 color — 预设", () => {
    expect(validateAgentData({ color: "primary" })).toBeNull();
  });

  // 无效 permission — string
  test("无效 permission — string", () => {
    expect(validateAgentData({ permission: "allow" })).toBe("INVALID_PERMISSION");
  });

  // 有效 permission — object
  test("有效 permission — object", () => {
    expect(validateAgentData({ permission: { bash: "allow" } })).toBeNull();
  });

  // 空对象返回 null
  test("空对象返回 null", () => {
    expect(validateAgentData({})).toBeNull();
  });
});

describe("toolsToPermission", () => {
  // 布尔值映射
  test("布尔值映射", () => {
    expect(toolsToPermission({ bash: true, read: false })).toEqual({ bash: "allow", read: "deny" });
  });
});

describe("normalizeKnowledgeConfig", () => {
  // null 返回 null
  test("null 返回 null", () => {
    expect(normalizeKnowledgeConfig(null)).toBeNull();
  });

  // 去重和 trim
  test("去重和 trim", () => {
    const result = normalizeKnowledgeConfig({
      knowledgeBaseIds: ["  kb_a  ", "kb_a", "kb_b"],
      policy: { searchFirst: true, maxResults: 5 },
    });
    expect(result!.knowledgeBaseIds).toEqual(["kb_a", "kb_b"]);
  });
});

describe("AGENT_SETTABLE_FIELDS", () => {
  // 包含 knowledge
  test("包含 knowledge", () => {
    expect(AGENT_SETTABLE_FIELDS).toContain("knowledge");
  });
});

describe("isBuiltInAgent", () => {
  // build 是内置
  test("build 是内置", () => expect(isBuiltInAgent("build")).toBe(true));
  // custom 不是内置
  test("custom 不是内置", () => expect(isBuiltInAgent("my-agent")).toBe(false));
});
