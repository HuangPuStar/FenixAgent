// AGENT_SETTABLE_FIELDS 白名单只保留当前仍参与 AgentConfig 写入的字段
import { describe, expect, test } from "bun:test";

import { AGENT_SETTABLE_FIELDS } from "../services/config/agent-config";

describe("AGENT_SETTABLE_FIELDS 当前白名单", () => {
  test("保留 extra 扩展字段", () => {
    expect(AGENT_SETTABLE_FIELDS).toContain("extra");
  });

  test("已移除历史高级字段", () => {
    expect(AGENT_SETTABLE_FIELDS).not.toContain("topP");
    expect(AGENT_SETTABLE_FIELDS).not.toContain("top_p");
    expect(AGENT_SETTABLE_FIELDS).not.toContain("permission");
    expect(AGENT_SETTABLE_FIELDS).not.toContain("color");
  });

  test("白名单集合与预期一致", () => {
    const expectedFields = ["modelId", "prompt", "description", "extra", "machineId", "knowledge"] as const;
    expect([...AGENT_SETTABLE_FIELDS].sort()).toEqual([...expectedFields].sort());
  });
});
