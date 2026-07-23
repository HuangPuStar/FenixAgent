import { describe, expect, test } from "bun:test";
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
