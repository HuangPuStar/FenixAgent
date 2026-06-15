// config/agent-config.ts 当前只保留 extra/knowledge 的轻量校验
import { describe, expect, test } from "bun:test";

const { validateAgentData, AGENT_SETTABLE_FIELDS } = await import("../services/config/agent-config");

describe("AGENT_SETTABLE_FIELDS", () => {
  test("不再保留 top_p / topP 历史映射", () => {
    expect((AGENT_SETTABLE_FIELDS as readonly string[]).includes("top_p")).toBe(false);
    expect((AGENT_SETTABLE_FIELDS as readonly string[]).includes("topP")).toBe(false);
  });
});

describe("validateAgentData extra 校验", () => {
  test("接受 object extra", () => {
    expect(validateAgentData({ extra: { foo: "bar" } })).toBeNull();
  });

  test("拒绝非 object extra", () => {
    expect(validateAgentData({ extra: "0.5" })).toBe("INVALID_EXTRA");
    expect(validateAgentData({ extra: [] })).toBe("INVALID_EXTRA");
  });
});
