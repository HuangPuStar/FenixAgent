import { describe, expect, it } from "bun:test";

// 测试 agent-config.ts 的 AGENT_SETTABLE_FIELDS 和 validateAgentData 边界

const { AGENT_SETTABLE_FIELDS, validateAgentData, isBuiltInAgent } = await import("../services/config/agent-config");

// ── AGENT_SETTABLE_FIELDS ──

describe("AGENT_SETTABLE_FIELDS", () => {
  // 确认已知字段都包含在列表中
  it("包含所���期望的可设置字段", () => {
    const expected = ["modelId", "prompt", "description", "extra", "machineId", "knowledge"];
    for (const field of expected) {
      expect((AGENT_SETTABLE_FIELDS as readonly string[]).includes(field)).toBe(true);
    }
  });
});

// ── validateAgentData ──

describe("validateAgentData", () => {
  // 合法输入通过
  it("合法数据返回 null", () => {
    expect(validateAgentData({ extra: { foo: "bar" } })).toBeNull();
    expect(validateAgentData({ knowledge: { knowledgeBaseIds: ["kb_1"] } })).toBeNull();
    expect(validateAgentData({})).toBeNull();
  });

  // extra 必须是 object/null
  it("拒绝非法 extra", () => {
    expect(validateAgentData({ extra: [] })).toBe("INVALID_EXTRA");
    expect(validateAgentData({ extra: "bad" })).toBe("INVALID_EXTRA");
  });

  // knowledge 校验仍然生效
  it("拒绝非法 knowledge", () => {
    expect(validateAgentData({ knowledge: { knowledgeBaseIds: [1] } })).toBe("INVALID_KNOWLEDGE_BASE_IDS");
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
