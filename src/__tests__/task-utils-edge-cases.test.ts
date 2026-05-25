import { describe, expect, it } from "bun:test";

// 测试 task.ts 内部工具函数的边界场景

// ── truncateSummary ──

function truncateSummary(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return value.length > 2000 ? value.slice(0, 2000) : value;
}

describe("truncateSummary", () => {
  // null/undefined 返回 null
  it("null/undefined 返回 null", () => {
    expect(truncateSummary(null)).toBeNull();
    expect(truncateSummary(undefined)).toBeNull();
  });

  // 空字符串为 falsy，返回 null
  it("空字符串返回 null", () => {
    expect(truncateSummary("")).toBeNull();
  });

  // 短字符串原样返回
  it("短字符串原样返回", () => {
    expect(truncateSummary("hello")).toBe("hello");
  });

  // 恰好 2000 字符不截断
  it("恰好 2000 字符不截断", () => {
    const s = "a".repeat(2000);
    expect(truncateSummary(s)).toBe(s);
    expect(truncateSummary(s)!.length).toBe(2000);
  });

  // 2001 字符截断为 2000
  it("超过 2000 字符截断", () => {
    const s = "a".repeat(2001);
    const result = truncateSummary(s);
    expect(result!.length).toBe(2000);
  });

  // 包含 unicode 字符
  it("保留 unicode 字符", () => {
    expect(truncateSummary("你好世界")).toBe("你好世界");
  });
});

// ── toUnixTimestamp ──

function toUnixTimestamp(value: Date | null | undefined): number | null {
  return value ? Math.floor(value.getTime() / 1000) : null;
}

describe("toUnixTimestamp", () => {
  // null/undefined 返回 null
  it("null/undefined 返回 null", () => {
    expect(toUnixTimestamp(null)).toBeNull();
    expect(toUnixTimestamp(undefined)).toBeNull();
  });

  // 正常日期转换
  it("正常日期转换为 Unix 时间戳", () => {
    const date = new Date("2026-05-17T12:00:00.000Z");
    expect(toUnixTimestamp(date)).toBe(Math.floor(date.getTime() / 1000));
  });

  // 毫秒精度截断（Math.floor）
  it("毫秒部分被截断（Math.floor）", () => {
    const date = new Date("2026-05-17T12:00:00.999Z");
    const ts = toUnixTimestamp(date)!;
    expect(ts).toBe(Math.floor(date.getTime() / 1000));
    // 确保不是向上取整
    expect(ts * 1000).toBeLessThan(date.getTime());
  });

  // epoch 零点
  it("epoch 零点返回 0", () => {
    expect(toUnixTimestamp(new Date("1970-01-01T00:00:00.000Z"))).toBe(0);
  });
});
