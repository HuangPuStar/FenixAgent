// 测试 scheduler/http-executor 的超时检测使用 instanceof Error 而非字符串匹配（兼容 Node.js/Bun）
// AbortSignal.timeout 在 Bun/Node.js 运行时触发时抛出 DOMException，name 为 "TimeoutError"/"AbortError"
import { describe, expect, test } from "bun:test";

// 纯函数测试：与 http-executor.ts catch 块中的 isTimeout 检测条件保持一致
// （executor 的检测为内联逻辑，复制实现做单元测试）
function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

describe("timeout detection instanceof Error", () => {
  // DOMException 的 TimeoutError（Bun 运行时 AbortSignal.timeout 实际抛出类型）
  test("detects DOMException TimeoutError (Bun runtime)", () => {
    const err = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    expect(isTimeoutError(err)).toBe(true);
  });

  // DOMException 的 AbortError
  test("detects DOMException AbortError", () => {
    const err = new DOMException("The operation was aborted", "AbortError");
    expect(isTimeoutError(err)).toBe(true);
  });

  // 普通 Error 且 name 为 TimeoutError（Node.js 运行时）
  test("detects plain Error with name TimeoutError (Node.js runtime)", () => {
    const err = new Error("Timeout");
    err.name = "TimeoutError";
    expect(isTimeoutError(err)).toBe(true);
  });

  // 普通 Error 且 name 为 AbortError
  test("detects plain Error with name AbortError", () => {
    const err = new Error("Aborted");
    err.name = "AbortError";
    expect(isTimeoutError(err)).toBe(true);
  });

  // 非 Error 对象不会被误判为超时
  test("non-Error objects are not detected as timeout", () => {
    expect(isTimeoutError("string error")).toBe(false);
    expect(isTimeoutError(42)).toBe(false);
    expect(isTimeoutError(null)).toBe(false);
    expect(isTimeoutError(undefined)).toBe(false);
  });

  // 普通 Error（无超时 name）不是超时
  test("generic Error is not detected as timeout", () => {
    const err = new Error("Network error");
    expect(isTimeoutError(err)).toBe(false);
  });

  // TypeError 不是超时
  test("TypeError is not detected as timeout", () => {
    const err = new TypeError("fetch failed");
    expect(isTimeoutError(err)).toBe(false);
  });
});
