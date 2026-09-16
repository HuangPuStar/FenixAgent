import { describe, expect, test } from "bun:test";

// ── toInvocationDate in-operator 类型守卫验证 ──
// 直接内联测试，不 mock scheduler 的依赖

// 复制 toInvocationDate 的逻辑（scheduler.ts 内部函数不导出）
function toInvocationDate(invocation: unknown): Date | null {
  if (!invocation) return null;
  if (invocation instanceof Date) return invocation;
  if (typeof invocation === "object" && invocation !== null) {
    if ("toDate" in invocation && typeof invocation.toDate === "function") {
      return (invocation as { toDate: () => Date }).toDate();
    }
    if ("toJSDate" in invocation && typeof invocation.toJSDate === "function") {
      return (invocation as { toJSDate: () => Date }).toJSDate();
    }
  }
  return null;
}

describe("toInvocationDate type guard", () => {
  // null/undefined/0/"" 返回 null
  test("returns null for falsy values", () => {
    expect(toInvocationDate(null)).toBeNull();
    expect(toInvocationDate(undefined)).toBeNull();
    expect(toInvocationDate(0)).toBeNull();
    expect(toInvocationDate("")).toBeNull();
  });

  // Date 实例直接返回
  test("returns Date instance directly", () => {
    const d = new Date("2026-01-01");
    expect(toInvocationDate(d)).toBe(d);
  });

  // 有 toDate 方法的对象（如 Luxon DateTime）
  test("calls toDate on objects with toDate method", () => {
    const d = new Date("2026-06-01");
    const obj = { toDate: () => d };
    expect(toInvocationDate(obj)).toBe(d);
  });

  // 有 toJSDate 方法的对象（如Moment）
  test("calls toJSDate on objects with toJSDate method", () => {
    const d = new Date("2026-06-01");
    const obj = { toJSDate: () => d };
    expect(toInvocationDate(obj)).toBe(d);
  });

  // toDate 为非函数属性时不调用
  test("ignores toDate when it is not a function", () => {
    const obj = { toDate: "2026-01-01" };
    expect(toInvocationDate(obj)).toBeNull();
  });

  // 普通对象返回 null
  test("returns null for plain objects", () => {
    expect(toInvocationDate({})).toBeNull();
    expect(toInvocationDate({ foo: "bar" })).toBeNull();
  });
});
