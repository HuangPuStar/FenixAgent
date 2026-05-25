// 测试 timeout 检测使用 instanceof Error 而非 DOMException（兼容 Node.js/Bun）
import { describe, expect, test } from "bun:test";

// 纯函数测试：验证错误类型检测逻辑
// 由于 executeTaskById 依赖 fetch/DB，这里直接测试检测条件的正确性

describe("timeout detection instanceof Error", () => {
  // 模拟 executeTaskById catch 块中的检测逻辑
  function isTimeoutError(err: unknown): boolean {
    return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
  }

  test("detects DOMException TimeoutError (Bun runtime)", () => {
    const err = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    expect(isTimeoutError(err)).toBe(true);
  });

  test("detects DOMException AbortError", () => {
    const err = new DOMException("The operation was aborted", "AbortError");
    expect(isTimeoutError(err)).toBe(true);
  });

  test("detects plain Error with name TimeoutError (Node.js runtime)", () => {
    const err = new Error("Timeout");
    err.name = "TimeoutError";
    expect(isTimeoutError(err)).toBe(true);
  });

  test("detects plain Error with name AbortError", () => {
    const err = new Error("Aborted");
    err.name = "AbortError";
    expect(isTimeoutError(err)).toBe(true);
  });

  test("non-Error objects are not detected as timeout", () => {
    expect(isTimeoutError("string error")).toBe(false);
    expect(isTimeoutError(42)).toBe(false);
    expect(isTimeoutError(null)).toBe(false);
    expect(isTimeoutError(undefined)).toBe(false);
  });

  test("generic Error is not detected as timeout", () => {
    const err = new Error("Network error");
    expect(isTimeoutError(err)).toBe(false);
  });

  test("TypeError is not detected as timeout", () => {
    const err = new TypeError("fetch failed");
    expect(isTimeoutError(err)).toBe(false);
  });
});
