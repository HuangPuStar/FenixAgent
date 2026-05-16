// R34: config/agent-config.ts FIELD_ALIAS 防御映射 + validateAgentData topP 校验
import { describe, test, expect } from "bun:test";

const { validateAgentData, AGENT_SETTABLE_FIELDS } = await import(
  "../services/config/agent-config"
);

describe("FIELD_ALIAS 防御映射", () => {
  // AGENT_SETTABLE_FIELDS 包含 top_p 用于路由白名单
  test("AGENT_SETTABLE_FIELDS 包含 top_p 和 topP", () => {
    expect((AGENT_SETTABLE_FIELDS as readonly string[]).includes("top_p")).toBe(true);
    expect((AGENT_SETTABLE_FIELDS as readonly string[]).includes("topP")).toBe(true);
  });
});

describe("validateAgentData topP 校验", () => {
  // topP 范围校验（与 top_p 共享同一规则）
  test("接受合法 topP 值", () => {
    expect(validateAgentData({ topP: 0 })).toBeNull();
    expect(validateAgentData({ topP: 0.5 })).toBeNull();
    expect(validateAgentData({ topP: 1 })).toBeNull();
  });

  // 拒绝超范围 topP
  test("拒绝超范围 topP", () => {
    expect(validateAgentData({ topP: -0.1 })).toBe("INVALID_TOP_P");
    expect(validateAgentData({ topP: 1.1 })).toBe("INVALID_TOP_P");
  });

  // 拒绝非数字 topP
  test("拒绝非数字 topP", () => {
    expect(validateAgentData({ topP: "0.5" })).toBe("INVALID_TOP_P");
  });

  // top_p 和 topP 同时存在时，任一无效即拒绝
  test("top_p 和 topP 同时存在时独立校验", () => {
    expect(validateAgentData({ top_p: 0.5, topP: 0.5 })).toBeNull();
    expect(validateAgentData({ top_p: 0.5, topP: 2 })).toBe("INVALID_TOP_P");
    expect(validateAgentData({ top_p: 2, topP: 0.5 })).toBe("INVALID_TOP_P");
  });

  // 原有 top_p 校验仍然有效
  test("top_p 校验仍然有效", () => {
    expect(validateAgentData({ top_p: 0.5 })).toBeNull();
    expect(validateAgentData({ top_p: 2 })).toBe("INVALID_TOP_P");
  });
});
