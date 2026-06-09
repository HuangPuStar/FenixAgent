import { describe, expect, test } from "bun:test";
import {
  AGENT_SETTABLE_FIELDS,
  isBuiltInAgent,
  normalizeKnowledgeConfig,
  validateAgentData,
} from "../../services/config/agent-config";

describe("validateAgentData", () => {
  // 有效数据返回 null
  test("有效数据返回 null", () => {
    expect(validateAgentData({ modelId: "model_1", extra: { display: "compact" } })).toBeNull();
  });

  // 无效 extra
  test("无效 extra", () => {
    expect(validateAgentData({ extra: "invalid" })).toBe("INVALID_EXTRA");
  });

  // 空对象返回 null
  test("空对象返回 null", () => {
    expect(validateAgentData({})).toBeNull();
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
    expect(AGENT_SETTABLE_FIELDS).toContain("extra");
  });
});

describe("isBuiltInAgent", () => {
  // build 是内置
  test("build 是内置", () => expect(isBuiltInAgent("build")).toBe(true));
  // custom 不是内置
  test("custom 不是内置", () => expect(isBuiltInAgent("my-agent")).toBe(false));
});
