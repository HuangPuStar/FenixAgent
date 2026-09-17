import { describe, expect, it } from "bun:test";
import { parseJsonb, parseJsonbOr } from "../services/config/jsonb";

// ── parseJsonb ──

describe("parseJsonb", () => {
  // 已解析的对象（Drizzle 新数据）
  it("直接返回已解析的对象", () => {
    const obj = { type: "local", command: ["npx"] };
    const result = parseJsonb<typeof obj>(obj);
    expect(result).toEqual(obj);
  });

  // 已解���的数组
  it("直接返回已解析的数组", () => {
    const result = parseJsonb<number[]>([1, 2, 3]);
    expect(result).toEqual([1, 2, 3]);
  });

  // null 返回 null
  it("null 返回 null", () => {
    expect(parseJsonb(null)).toBeNull();
  });

  // undefined 返回 null
  it("undefined 返回 null", () => {
    expect(parseJsonb(undefined)).toBeNull();
  });

  // 单层 JSON 字符串（旧 jsonb 数据）
  it("解析单层 JSON 字符串", () => {
    const encoded = JSON.stringify({ foo: "bar" });
    const result = parseJsonb<{ foo: string }>(encoded);
    expect(result).toEqual({ foo: "bar" });
  });

  // 双重编码 JSON 字符串（旧代码 bug 导致）
  it("解析双重编码的 JSON 字符串", () => {
    const original = { type: "remote", url: "https://example.com" };
    const doubleEncoded = JSON.stringify(JSON.stringify(original));
    const result = parseJsonb<typeof original>(doubleEncoded);
    expect(result).toEqual(original);
  });

  // 非法 JSON 字符串返回 null
  it("非法 JSON 返回 null", () => {
    expect(parseJsonb("not-json")).toBeNull();
  });

  // 布尔值直接返回
  it("布尔值直接返回", () => {
    expect(parseJsonb<boolean>(true)).toBe(true);
    expect(parseJsonb<boolean>(false)).toBe(false);
  });

  // 数字直接返回
  it("数字直接返回", () => {
    expect(parseJsonb<number>(42)).toBe(42);
  });

  // JSON 字符串化的空字符串 → 解析后为 string 类型，尝试二次解析失败 → null
  it("JSON 编码的空字符串返回 null", () => {
    expect(parseJsonb('""')).toBeNull();
  });

  // 嵌套对象
  it("正确处理嵌套对象", () => {
    const nested = { policy: { searchFirst: true, maxResults: 5 } };
    expect(parseJsonb<typeof nested>(nested)).toEqual(nested);
    expect(parseJsonb<typeof nested>(JSON.stringify(nested))).toEqual(nested);
  });
});

// ── parseJsonbOr ──

describe("parseJsonbOr", () => {
  it("正常值返回解析结果", () => {
    expect(parseJsonbOr({ a: 1 }, {})).toEqual({ a: 1 });
  });

  it("null 返回 fallback", () => {
    expect(parseJsonbOr(null, { default: true })).toEqual({ default: true });
  });

  it("无效字符串返回 fallback", () => {
    expect(parseJsonbOr("invalid", [])).toEqual([]);
  });
});
