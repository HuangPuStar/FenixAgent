import { describe, expect, test } from "bun:test";
import { ENGINE_TYPES } from "../services/config/types";

describe("ENGINE_TYPES 常量", () => {
  test("包含 opencode、ccb、claude-code 与 peri", () => {
    expect(ENGINE_TYPES).toEqual(["opencode", "ccb", "claude-code", "peri"]);
  });

  test("是 readonly 元组", () => {
    expect(ENGINE_TYPES.length).toBe(4);
    expect(ENGINE_TYPES[0]).toBe("opencode");
    expect(ENGINE_TYPES[1]).toBe("ccb");
    expect(ENGINE_TYPES[2]).toBe("claude-code");
    expect(ENGINE_TYPES[3]).toBe("peri");
  });
});
