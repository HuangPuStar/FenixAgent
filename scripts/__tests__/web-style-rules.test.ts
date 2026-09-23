import { expect, test } from "bun:test";

import { classifyClassToken, findWebStyleViolations, splitTopLevel } from "../lib/web-style-rules";

/**
 * 规则口径的自测。
 *
 * 规则由 `docs/developer/guide/forbidden-code-patterns.md` 定义，这里是它的执行锚点：
 * 反例、正例、优先级、扫描单位（字符串字面量而非整文件）四条都锁住，
 * 任何一次「放宽判定」都必须先改这些用例，改不动就说明是在放松门禁。
 */

/** 用户提供的真实反例（原样保留）：一条样式常量串起布局、颜色、阴影、过渡、5 组子代选择器与 4 段响应式。 */
const SUMMARY_CARD_SOURCE = `
const SUMMARY_CARD =
  "grid w-full min-h-[72px] grid-cols-[32px_minmax(0,1fr)_12px] items-center gap-[10px] rounded-[11px] border " +
  "border-[#e0e7f0] bg-[rgb(255_255_255_/_94%)] px-[9px] py-[10px] text-left text-[#53637b] " +
  "shadow-[0_4px_14px_rgb(35_60_105_/_5%)] " +
  "transition-[border-color_140ms_ease,transform_140ms_ease,box-shadow_140ms_ease] " +
  "[&:hover]:-translate-x-[2px] [&:hover]:border-[#aac3ef] [&:hover]:shadow-[0_8px_20px_rgb(35_60_105_/_9%)] " +
  "[&>span]:grid [&>span]:size-8 [&>span]:place-items-center [&>span]:rounded-[9px] [&>span]:bg-[#eaf2ff] [&>span]:text-[#2f69d2] " +
  "[&>div]:flex [&>div]:min-w-0 [&>div]:flex-col [&>svg]:w-[11px] [&>svg]:text-[#a2adbd] " +
  "[@media(min-width:760px)and(max-width:1119px)]:min-h-[48px] [@media(min-width:760px)and(max-width:1119px)]:grid-cols-[24px_minmax(0,1fr)_10px] " +
  "[@media(min-width:760px)and(max-width:1119px)]:px-[7px] [@media(min-width:760px)and(max-width:1119px)]:py-[6px] " +
  "[@media(min-width:760px)and(max-width:1119px)]:[&>span]:size-6";
`;

// 真实反例必须被全量命中：漏一处，规则就等于对这类写法开了口子。
test("SUMMARY_CARD 反例的 30 处写法全部命中，且规则分布为 01×8 / 02×17 / 03×5", () => {
  const violations = findWebStyleViolations("summary-card.ts", SUMMARY_CARD_SOURCE);
  const counts = new Map<string, number>();
  for (const violation of violations) {
    counts.set(violation.ruleId, (counts.get(violation.ruleId) ?? 0) + 1);
  }

  expect(violations).toHaveLength(30);
  expect(Object.fromEntries(counts)).toEqual({ "FCP-WEB-01": 8, "FCP-WEB-02": 17, "FCP-WEB-03": 5 });
});

// 反例里同时含任意断点和子代选择器时，报最外层的响应式规则——同一个 token 只报一条，否则报告会刷屏。
test("变体优先于值：[@media...]:[&>span]:size-6 报响应式而非深层样式", () => {
  expect(classifyClassToken("[@media(min-width:760px)and(max-width:1119px)]:[&>span]:size-6")).toBe("FCP-WEB-03");
});

// 深层样式（选择器嵌套）优先于值侧的任意值：改的是结构表达式，单改 [11px] 没有意义。
test("选择器嵌套优先于任意值：[&>svg]:w-[11px] 报 02", () => {
  expect(classifyClassToken("[&>svg]:w-[11px]")).toBe("FCP-WEB-02");
});

// 三条规则的判定边界：标准刻度、规范断点、CSS 变量逃生舱口、data-/aria- 变体都不是违规。
test("规则判定表：违规写法与合法写法逐条对齐", () => {
  const cases: [string, string | null][] = [
    ["text-[12px]", "FCP-WEB-01"],
    ["sm:max-w-[480px]", "FCP-WEB-01"],
    ["border-[#e0e7f0]", "FCP-WEB-01"],
    ["divide-[rgba(0,0,0,0.08)]", "FCP-WEB-01"],
    ["shadow-[0_4px_14px_rgb(35_60_105_/_5%)]", "FCP-WEB-02"],
    ["grid-cols-[32px_minmax(0,1fr)_12px]", "FCP-WEB-02"],
    ["[&>small]:whitespace-nowrap", "FCP-WEB-02"],
    ["[.dark_&]:bg-[rgba(255,255,255,0.08)]", "FCP-WEB-02"],
    ["[@media(max-width:759px)]:flex", "FCP-WEB-03"],
    ["min-[760px]:hidden", "FCP-WEB-03"],
    ["md:[@supports(display:grid)]:grid", "FCP-WEB-03"],
    ["grid", null],
    ["text-xs", null],
    ["md:max-lg:hidden", null],
    ["data-[state=open]:bg-accent", null],
    ["aria-[sort=ascending]:pl-2", null],
    ["bg-[var(--surface-1)]", null],
    ["w-[calc(var(--rail)*2)]", null],
  ];

  expect(cases.map(([token]) => [token, classifyClassToken(token)] as const)).toEqual(cases);
});

// 反例经常被写进注释解释「不要这样写」；以字符串字面量为扫描单位，注释不会被误报成违规。
test("注释里的反例不报", () => {
  const source = `
// 反面教材：不要写 text-[12px] 或 [&>span]:size-8
/* 也不要写 [@media(max-width:759px)]:hidden */
export const CLASSES = "flex items-center";
`;

  expect(findWebStyleViolations("comment.ts", source)).toEqual([]);
});

// 模板字面量同样承载类名，必须与普通字符串字面量一视同仁，否则动态拼接就成了绕过门禁的口子。
test("模板字面量中的类名同样命中", () => {
  const source = `const classes = \`flex \${active ? "text-[12px]" : "text-xs"} gap-2\`;`;
  const violations = findWebStyleViolations("template.tsx", source);

  expect(violations.map((violation) => violation.token)).toEqual(["text-[12px]"]);
});

// 位置信息用于直接跳到现场；模板字符串里嵌套表达式时，命中行号不能被前面的偏移带偏。
test("命中位置指向真实行列", () => {
  const source = 'const STYLE = "flex items-center";\nconst BAD = "text-[12px]";\n';
  const [violation] = findWebStyleViolations("position.ts", source);

  expect(violation).toMatchObject({ ruleId: "FCP-WEB-01", line: 2, column: 14, token: "text-[12px]" });
});

// 任意值内部允许出现冒号，顶层切分必须跳过方括号内部，否则变体链会被切碎。
test("顶层切分不切进任意值内部的冒号", () => {
  expect(splitTopLevel("[@media(min-width:760px)]:[&>span]:size-6")).toEqual([
    "[@media(min-width:760px)]",
    "[&>span]",
    "size-6",
  ]);
});
