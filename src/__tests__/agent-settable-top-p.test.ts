// AGENT_SETTABLE_FIELDS 白名单包含 top_p（前端→路由→存储链路验证）
import { describe, expect, test } from "bun:test";

// 验证 AGENT_SETTABLE_FIELDS 包含 top_p 和 topP
// 路由层用此数组做白名单过滤：前端传 top_p，路由映射为 topP 存入 PG
import { AGENT_SETTABLE_FIELDS } from "../services/config/agent-config";

describe("AGENT_SETTABLE_FIELDS top_p 白名单", () => {
  test("AGENT_SETTABLE_FIELDS 应包含 topP（PG 列名）", () => {
    expect(AGENT_SETTABLE_FIELDS).toContain("topP");
  });

  test("AGENT_SETTABLE_FIELDS 应包含 top_p（前端字段名）", () => {
    // 前端发送 top_p，路由白名单过滤依赖此字段通过
    expect(AGENT_SETTABLE_FIELDS).toContain("top_p");
  });

  test("top_p 和 topP 共存不影响其他字段", () => {
    const expectedFields = [
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
    ] as const;
    expect([...AGENT_SETTABLE_FIELDS].sort()).toEqual([...expectedFields].sort());
  });
});
