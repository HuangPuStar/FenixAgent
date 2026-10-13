import { describe, expect, test } from "bun:test";
import { toInvocationDate } from "../server/services/scheduler/utils";

// toInvocationDate 的 in-operator 类型守卫验证。
// 直接导入实现而不是复制一份：原用例内联了同样的条件（理由写的是「内部函数不导出」），复制件与实现漂移时
// 用例照样全绿；W2 把该函数从 scheduler/index.ts 提到 services/scheduler/utils.ts 后，用例改为断言真身。

describe("toInvocationDate type guard", () => {
  // 假值（null/undefined/0/""）必须返回 null，避免把「没有下次执行」写成一个纪元时间。
  test("returns null for falsy values", () => {
    expect(toInvocationDate(null)).toBeNull();
    expect(toInvocationDate(undefined)).toBeNull();
    expect(toInvocationDate(0)).toBeNull();
    expect(toInvocationDate("")).toBeNull();
  });

  // Date 实例按原引用返回，返回值要能直接写回 nextRunAt 而不引入时区换算。
  test("returns Date instance directly", () => {
    const d = new Date("2026-01-01");
    expect(toInvocationDate(d)).toBe(d);
  });

  // 带 toDate 的对象（如 Luxon DateTime）取 toDate() 的结果。
  test("calls toDate on objects with toDate method", () => {
    const d = new Date("2026-06-01");
    const obj = { toDate: () => d };
    expect(toInvocationDate(obj)).toBe(d);
  });

  // 带 toJSDate 的对象（如 Moment）取 toJSDate() 的结果。
  test("calls toJSDate on objects with toJSDate method", () => {
    const d = new Date("2026-06-01");
    const obj = { toJSDate: () => d };
    expect(toInvocationDate(obj)).toBe(d);
  });

  // toDate 存在但不是函数时必须忽略，否则会在调度路径上抛出 TypeError 而非降级为 null。
  test("ignores toDate when it is not a function", () => {
    const obj = { toDate: "2026-01-01" };
    expect(toInvocationDate(obj)).toBeNull();
  });

  // 普通对象不带运行时日期接口，必须降级为 null 而不是猜一个时间。
  test("returns null for plain objects", () => {
    expect(toInvocationDate({})).toBeNull();
    expect(toInvocationDate({ foo: "bar" })).toBeNull();
  });
});
