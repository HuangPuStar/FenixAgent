// R35: agent-config.ts buildSetFromData 辅助函数（验证字段映射间接行为）
import { describe, expect, test } from "bun:test";
import { AGENT_SETTABLE_FIELDS, validateAgentData } from "../services/config/agent-config";

describe("buildSetFromData 字段映射", () => {
  // AGENT_SETTABLE_FIELDS 包含所有可写字段
  test("AGENT_SETTABLE_FIELDS 覆盖所有已知字段", () => {
    // 当前白名单字段（steps/mode/permission/variant/temperature/topP/top_p/disable/hidden/color 等已迁移到 extra JSONB）
    const fields = ["model", "modelId", "prompt", "description", "extra", "machineId", "knowledge"];
    for (const f of fields) {
      expect((AGENT_SETTABLE_FIELDS as readonly string[]).includes(f)).toBe(true);
    }
  });

  // top_p 通过 FIELD_ALIAS 映射为 topP（验证字段映射完整链路）
  test("top_p 和 topP 都走 validateAgentData 校验", () => {
    expect(validateAgentData({ top_p: 0.5 })).toBeNull();
    expect(validateAgentData({ topP: 0.5 })).toBeNull();
    expect(validateAgentData({ top_p: 2 })).toBe("INVALID_TOP_P");
    expect(validateAgentData({ topP: 2 })).toBe("INVALID_TOP_P");
  });

  // knowledge 字段透传
  test("knowledge 字段可正确透传", () => {
    expect(validateAgentData({ knowledge: null })).toBeNull();
    expect(validateAgentData({ knowledge: { knowledgeBaseIds: ["kb1"] } })).toBeNull();
  });

  // 所有字段均在 settable 列表中
  test("AGENT_SETTABLE_FIELDS 数量稳定", () => {
    expect(AGENT_SETTABLE_FIELDS.length).toBe(7);
  });
});
