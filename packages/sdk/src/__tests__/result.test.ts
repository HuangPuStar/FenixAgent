import { describe, expect, it } from "bun:test";
import { err, ok } from "../result";

describe("Result type", () => {
  it("ok() 返回成功结果", () => {
    const result = ok(42);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBe(42);
    }
  });

  it("err() 返回错误结果", () => {
    const result = err("SOMETHING_WRONG", "出错了");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SOMETHING_WRONG");
      expect(result.error.message).toBe("出错了");
    }
  });

  it("ok() 支持 undefined data", () => {
    const result = ok(undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBeUndefined();
    }
  });

  it("TS 能正确收窄类型", () => {
    const result = ok("hello");
    if (result.ok) {
      const _str: string = result.data;
      expect(_str).toBe("hello");
    }
  });
});
