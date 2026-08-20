import { describe, expect, test } from "bun:test";
import { ENGINE_TYPES } from "../services/config/types";

describe("ENGINE_TYPES 常量", () => {
  // Peri 是独立引擎类型，并在实现层复用 CCB-compatible runtime。
  test("包含 peri、opencode、ccb 和 claude-code", () => {
    expect(ENGINE_TYPES).toEqual(["peri", "opencode", "ccb", "claude-code"]);
  });

  // 引擎集合是不可变元组，默认值由启动配置而非数组顺序决定。
  test("是 readonly 元组", () => {
    expect(ENGINE_TYPES.length).toBe(4);
    expect(ENGINE_TYPES[0]).toBe("peri");
    expect(ENGINE_TYPES[1]).toBe("opencode");
    expect(ENGINE_TYPES[2]).toBe("ccb");
    expect(ENGINE_TYPES[3]).toBe("claude-code");
  });
});
