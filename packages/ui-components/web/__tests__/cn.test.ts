// web/__tests__/cn.test.ts
// 守护 `web/lib/cn.ts` 的行为契约。`cn` 现在是全仓唯一的类名合成实现：宿主 `apps/web/src/lib/utils.ts`
// 的逐字副本随 `dd3ad35d` 退场，FileTabsBar / TopModeTabs / routes/admin 三个生产消费方改指本包出口。
//
// 为什么必须单独一份行为断言：`dd3ad35d` 的提交说明称被删的两条 `cn` 断言「已由
// `barrel-exports.test.ts` 覆盖」，但那份测试里的 `cn` 只出现在导出名清单里（`lib: [..., "cn", ...]`），
// 属「导出存在性」检查；宿主测试 `apps/web/src/__tests__/utils.test.ts` 被一并删除后，全仓再无一处调用
// `cn(...)` 断言其行为。实现有两层语义（`clsx` 的条件/结构化输入 + `tailwind-merge` 的同族工具类消解），
// 任一层被换掉（例如退化成裸 `join(" ")`、或 twMerge 换成 `clsx`）都不影响导出存在性，只会静默改变
// 全部消费方的 class 结果——所以这里把两层各钉一条，并明确「去重的边界是 Tailwind 冲突类，不是通用去重」。
//
// 期望值均取自当前实现的实测结果（`cn` = `twMerge(clsx(inputs))`），不是从语义推演的应有行为。

import { describe, expect, test } from "bun:test";
import { cn } from "@fenix/ui-components/lib/cn";
import * as barrel from "../index";

describe("cn", () => {
  // 基础拼接：多个类名按输入顺序以单空格连接
  test("按输入顺序拼接类名", () => {
    expect(cn("a", "b")).toBe("a b");
  });

  // falsy 过滤：条件表达式为假时不留下多余空格或 "false" 字样
  test("过滤 falsy 值，不残留空串或占位文本", () => {
    expect(cn("a", false && "b")).toBe("a");
    expect(cn(undefined, null, false, "", "a")).toBe("a");
  });

  // 无有效输入时返回空串，调用方可以把它整体塞进 className 而不产生多余字符
  test("无有效输入时返回空串", () => {
    expect(cn()).toBe("");
    expect(cn(null, undefined, false)).toBe("");
  });

  // clsx 语义：数组被展平、对象按布尔值取键——这一层是消费方写条件类名的依赖
  test("接受 clsx 的结构化输入：数组展平、对象按值取键", () => {
    expect(cn(["a", "b"])).toBe("a b");
    expect(cn({ a: true, b: false })).toBe("a");
  });

  // tailwind-merge 语义：同族工具类冲突时后者胜（无论冲突发生在两个参数之间还是同一个字符串内部）
  test("同族 Tailwind 类冲突时后者胜", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
    expect(cn("px-2 py-1 p-4")).toBe("p-4");
    expect(cn("bg-red-500", "bg-blue-500")).toBe("bg-blue-500");
  });

  // 去重的边界：只消解同族工具类，不同族类名与重复字面量都原样保留（避免消费方误以为 cn 会通用去重）
  test("只消解同族冲突：不同族类名与重复字面量原样保留", () => {
    expect(cn("p-2", "m-4")).toBe("p-2 m-4");
    expect(cn("a", "a")).toBe("a a");
  });

  // 变体前缀参与分组：只有同一 variant 下的同族类才算冲突，跨 variant 必须共存
  test("variant 前缀参与冲突分组", () => {
    expect(cn("hover:p-2", "hover:p-4")).toBe("hover:p-4");
    expect(cn("hover:p-2", "focus:p-2")).toBe("hover:p-2 focus:p-2");
  });

  // 包出口与实现同源：`@fenix/ui-components/lib` 暴露的必须是本模块这一个函数，
  // 防止「出口指向另一份同名实现」——那正是本轮去重要消灭的形态
  test("barrel 出口的 cn 与 lib/cn 是同一个函数", () => {
    expect(barrel.cn).toBe(cn);
  });
});
