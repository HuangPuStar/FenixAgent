import { describe, expect, it } from "bun:test";

// 测试 listSkillSources 中错误状态区分逻辑（非超时错误 vs 超时）

describe("listSkillSources 错误状态区分", () => {
  // 模拟 results 处理逻辑中的判断
  function classifyRejection(reason: unknown): "timeout" | "offline" {
    const isTimeout = reason instanceof Error && reason.message === "TIMEOUT";
    return isTimeout ? "timeout" : "offline";
  }

  // 超时错误标记为 timeout
  it("超时错误标记为 timeout", () => {
    expect(classifyRejection(new Error("TIMEOUT"))).toBe("timeout");
  });

  // 权限错误标记为 offline（而非误标 timeout）
  it("权限错误标记为 offline", () => {
    expect(classifyRejection(new Error("EACCES: permission denied"))).toBe("offline");
  });

  // 路径不存在标记为 offline
  it("ENOENT 错误标记为 offline", () => {
    expect(classifyRejection(new Error("ENOENT: no such file"))).toBe("offline");
  });

  // 非 Error 类型标记为 offline
  it("非 Error 类型标记为 offline", () => {
    expect(classifyRejection("some string")).toBe("offline");
    expect(classifyRejection(null)).toBe("offline");
  });

  // 磁盘错误标记为 offline
  it("磁盘错误标记为 offline", () => {
    expect(classifyRejection(new Error("ENOSPC: no space left"))).toBe("offline");
  });
});
