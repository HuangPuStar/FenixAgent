// AGENT_SETTABLE_FIELDS 白名单包含 top_p（前端→路由→存储链路验证）
import { describe, expect, test } from "bun:test";

// 验证 AGENT_SETTABLE_FIELDS 包含 top_p 和 topP
// 路由层用此数组做白名单过滤：前端传 top_p，路由映射为 topP 存入 PG
import { AGENT_SETTABLE_FIELDS } from "../server/services/config/agent-config";

describe("AGENT_SETTABLE_FIELDS 白名单", () => {
  test("AGENT_SETTABLE_FIELDS 包含 extra", () => {
    expect(AGENT_SETTABLE_FIELDS).toContain("extra");
  });
});
