import { describe, expect, test } from "bun:test";
import { isTimeoutAbortError } from "../server/services/scheduler/utils";

// http-executor 的超时检测：按 instanceof Error + name 判定，而非字符串匹配消息。
// AbortSignal.timeout 触发时在 Bun/Node.js 抛出 DOMException 或 Error，name 为 "TimeoutError"/"AbortError"。
// 直接导入实现而不是复制条件：内联判定（原实现）会让用例复制同一份条件，复制件漂移时用例照样全绿。

describe("timeout detection instanceof Error", () => {
  // Bun 运行时 AbortSignal.timeout 抛出的 DOMException（name = TimeoutError）必须判为超时。
  test("detects DOMException TimeoutError (Bun runtime)", () => {
    const err = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    expect(isTimeoutAbortError(err)).toBe(true);
  });

  // 调用方主动 abort 产生的 DOMException（name = AbortError）同样归类为超时。
  test("detects DOMException AbortError", () => {
    const err = new DOMException("The operation was aborted", "AbortError");
    expect(isTimeoutAbortError(err)).toBe(true);
  });

  // Node.js 运行时抛的是普通 Error，仅 name 为 TimeoutError，也必须判为超时。
  test("detects plain Error with name TimeoutError (Node.js runtime)", () => {
    const err = new Error("Timeout");
    err.name = "TimeoutError";
    expect(isTimeoutAbortError(err)).toBe(true);
  });

  // 普通 Error 且 name 为 AbortError 时同样判为超时。
  test("detects plain Error with name AbortError", () => {
    const err = new Error("Aborted");
    err.name = "AbortError";
    expect(isTimeoutAbortError(err)).toBe(true);
  });

  // 非 Error 的抛出值（字符串/数字/null）不得误判为超时，否则会把网络故障记成超时。
  test("non-Error objects are not detected as timeout", () => {
    expect(isTimeoutAbortError("string error")).toBe(false);
    expect(isTimeoutAbortError(42)).toBe(false);
    expect(isTimeoutAbortError(null)).toBe(false);
    expect(isTimeoutAbortError(undefined)).toBe(false);
  });

  // 无超时 name 的普通 Error 是失败而非超时，两者在运维处置上不同。
  test("generic Error is not detected as timeout", () => {
    const err = new Error("Network error");
    expect(isTimeoutAbortError(err)).toBe(false);
  });

  // TypeError（如 fetch 解析失败）不得归类为超时。
  test("TypeError is not detected as timeout", () => {
    const err = new TypeError("fetch failed");
    expect(isTimeoutAbortError(err)).toBe(false);
  });
});
