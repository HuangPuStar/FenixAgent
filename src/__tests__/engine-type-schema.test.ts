import { describe, expect, test } from "bun:test";
import { ENGINE_TYPES } from "../services/config/types";

describe("ENGINE_TYPES 常量", () => {
  // Peri 通过 ccb 槽位复用既有 ACP handler 与配置生成，支持的引擎集合保持兼容。
  test("包含 opencode、ccb 和 claude-code", () => {
    expect(ENGINE_TYPES).toEqual(["opencode", "ccb", "claude-code"]);
  });

  // 引擎集合是不可变元组，默认值由启动配置而非数组顺序决定。
  test("是 readonly 元组", () => {
    expect(ENGINE_TYPES.length).toBe(3);
    expect(ENGINE_TYPES[0]).toBe("opencode");
    expect(ENGINE_TYPES[1]).toBe("ccb");
    expect(ENGINE_TYPES[2]).toBe("claude-code");
  });
});
