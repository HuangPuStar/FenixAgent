// web/__tests__/agent-editor-overscroll-chain.test.ts
// 「智能体编辑面板三栏在 `overscroll-contain` 上一致」的结构守卫。
//
// 背景（判据来源：2026-09-23 全仓 `overscroll-contain` 复核，最小装置归档在 `/tmp/overscroll-probe/`）：
// 三栏都是工作区里的常规流列，且位于**更长可滚祖先**之内——宿主是智能体管理页时，祖先链上唯一可被
// 用户滚动的容器是 `AppPage` 的 `main`（headless Chrome 复刻实测 1440×900：clientH 900 / scrollH 1955）；
// 列自身 `overflow-y-auto` 但内容通常不溢出（实测列高 787px，左栏内容 ≈254px、右栏 ≈481px）。指针停在
// 列上时浏览器判定滚轮由本列消费：本列没得滚、也不链式上溯 → **随指针位置移动的滚轮死区**（实测含类时
// 向下 3×120 自身 0→0 且 `main` 0→0，向上 `main` 已滚 300 同为 300→300，双向都死）。
//
// 为什么选「三栏都不带」：同一面板的头部、页脚、中栏都会链式上溯滚 `main`（实测 0→120 / 0→360 /
// 中栏贴底后 0→240），只有左右两列例外——去掉是**与已成立的行为对齐**，不是引入新行为。收益：面板是
// `top-3 bottom-3` 锚在宿主盒子上（可高过视口），管理页可滚时点「编辑」会把面板顶部留在视口外，含类时
// 指针若落在左右两列上，一个滚轮都动不了、没法把面板滚回来。代价（有意取舍）：去掉后滚轮会链式上溯，
// **被非模态浮层遮住的管理页会跟着动**（面板随页面移动）。
//
// 迁移遗留（这条不变量为何值得写成测试）：旧 `agent-editor.css` 的组选择器
// `.agent-editor-map, .agent-editor-content, .agent-editor-summary { … overscroll-behavior: contain }`
// 三栏都有，迁移时只有中栏丢了这一行，三栏本就不一致——漏改一处不会报错，只会在界面上表现为
// 「滚轮在某些列上突然不动」，没有任何运行时断言能发现它。
//
// 拦得住：三栏里任意一栏被单独加回或漏删 `overscroll-contain`（含右栏的两个来源：加载壳常量与完成态
// 内联类串）、以及左栏 `≤759px` 横向条带变体被顺手改动。
// 拦不住：① 类串被搬到新常量/新渲染点后仍带该类（本文件只认登记过的四处来源）；
// ② 运行时动态挂载的其它滚动容器（如 ui-components 内部节点）；③ Radix portal 里的浮层。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const EDITOR_DIR = resolve(import.meta.dir, "../pages/agent-panel/agent-editor");
const CLASSES_FILE = "agent-editor-classes.ts";
const CHROME_FILE = "AgentEditorChrome.tsx";
const DIALOG_FILE = "AgentFormDialog.tsx";
const BODY_FILE = "agent-editor-body.tsx";
const LOADING_SHELL_FILE = "AgentEditorLoadingShell.tsx";

/** 本次裁定的属性：三栏要么都带、要么都不带；当前期望「都不带」。 */
const PROPERTY = "overscroll-contain";

const readEditorFile = (name: string): string => readFileSync(join(EDITOR_DIR, name), "utf8");

/**
 * 取模块级常量的类串：`[export] const NAME = "…" + "…";`，多段字符串按字面量顺序合并（与运行时拼接
 * 等价）。只认双引号：本目录的类串常量一律写双引号（另有 `cn("…")` 形式的调用，不在此范围）。
 */
function classConstant(file: string, name: string): string {
  const source = readEditorFile(file);
  const match = new RegExp(`\\bconst ${name}\\s*=\\s*`).exec(source);
  if (!match) throw new Error(`${file} 里找不到常量 ${name}`);
  const body = source.slice(match.index + match[0].length);
  const end = body.indexOf(";\n");
  if (end < 0) throw new Error(`${file} 的常量 ${name} 没有以分号结束`);
  return [...body.slice(0, end).matchAll(/"([^"]*)"/g)].map((chunk) => chunk[1]).join("");
}

/** 右栏在完成态不是常量，而是 `AgentEditorChrome.tsx` 里 `<aside>` 的内联类串。 */
function summaryAsideClass(): string {
  const match = readEditorFile(CHROME_FILE).match(/<aside className="(agent-editor-summary-aside[^"]*)"/);
  if (!match) throw new Error(`${CHROME_FILE} 里找不到右栏（agent-editor-summary-aside）的内联类串`);
  return match[1];
}

/**
 * 三栏的**四处**类串来源（右栏有两个：加载壳常量 + 完成态内联）。
 * `role` 进断言消息，红的时候直接指出是哪一栏。
 */
function columns(): Array<{ role: string; source: string; classes: string }> {
  return [
    { role: "左栏配置地图", source: `${CLASSES_FILE} CONFIG_MAP`, classes: classConstant(CLASSES_FILE, "CONFIG_MAP") },
    { role: "中栏内容区（基准）", source: `${CLASSES_FILE} CONTENT`, classes: classConstant(CLASSES_FILE, "CONTENT") },
    {
      role: "右栏汇总（加载壳）",
      source: `${CLASSES_FILE} SUMMARY_ASIDE`,
      classes: classConstant(CLASSES_FILE, "SUMMARY_ASIDE"),
    },
    { role: "右栏汇总（完成态）", source: `${CHROME_FILE} <aside>`, classes: summaryAsideClass() },
  ];
}

/** 按整 token 判定，不做子串匹配：`overscroll-contain` 若被拼进更长的类名不该算命中。 */
const hasToken = (classes: string, token: string): boolean => classes.split(/\s+/).filter(Boolean).includes(token);

describe("智能体编辑面板三栏的滚动链", () => {
  test("四处类串都能解析出来，且渲染点确实引用它们（守卫不空转）", () => {
    for (const column of columns()) {
      // 空串会让「都不含 overscroll-contain」平凡成立，必须先钉住解析本身有效。
      expect(column.classes.length).toBeGreaterThan(0);
    }
    // 左/右两栏是被裁定的限高滚动列，中栏是本次对齐的基准（`overflow-x-hidden` 使 `overflow-y` 计算为 auto）。
    expect(hasToken(classConstant(CLASSES_FILE, "CONFIG_MAP"), "overflow-y-auto")).toBe(true);
    expect(hasToken(classConstant(CLASSES_FILE, "SUMMARY_ASIDE"), "overflow-y-auto")).toBe(true);
    expect(hasToken(classConstant(CLASSES_FILE, "CONTENT"), "overflow-x-hidden")).toBe(true);

    // 常量只有挂在真实渲染点上才受本守卫覆盖：面板（桌面 + 移动 Sheet）的标记在
    // `agent-editor-body.tsx`（§4.7 拆分后 `AgentFormDialog.tsx` 只剩容器与 portal），
    // 加载壳走 AgentEditorLoadingShell；右栏完成态由 AgentEditorSummary 的内联类串承担。
    expect(readEditorFile(DIALOG_FILE)).toContain("<AgentEditorBody");
    expect(readEditorFile(BODY_FILE)).toContain("className={CONFIG_MAP}");
    expect(readEditorFile(BODY_FILE)).toContain("className={CONTENT}");
    expect(readEditorFile(BODY_FILE)).toContain("<AgentEditorSummary");
    expect(readEditorFile(LOADING_SHELL_FILE)).toContain("className={CONFIG_MAP}");
    expect(readEditorFile(LOADING_SHELL_FILE)).toContain("className={SUMMARY_ASIDE}");
  });

  test("三栏在 overscroll-contain 上一致（当前期望：都不含）", () => {
    const flags = columns().map((column) => ({ 栏: column.role, 含该属性: hasToken(column.classes, PROPERTY) }));

    // ① 不变量：三栏要么都带、要么都不带——不允许「只给某一栏加回」这种半吊子状态。
    //    断言体是「破规则的那几栏」而不是一个布尔：红的时候直接给出栏名与来源，不用回头数下标。
    expect(flags.filter((entry) => entry.含该属性)).toEqual([]);
    // ② 冻结期望＝「都不带」这一支（对齐头部/页脚/中栏的既有实测行为：含类会让面板露不全时滚不回去）。
    //    将来若要整体改回「都带」，把 ① 换成 `filter((entry) => !entry.含该属性)` 即可——但别只改一栏，
    //    那正是本用例存在的理由。
    expect(flags.map((entry) => entry.含该属性)).toEqual([false, false, false, false]);
  });

  test("左栏 ≤759px 的横向条带变体保持原样（不受本次裁定影响）", () => {
    // 移动档面板是 Radix Sheet（modal、无祖先可滚），复核实测含类与去掉读数一致，故保持原样；
    // 这条同时挡住「顺手把 max-md 变体一起删掉」。
    const configMap = classConstant(CLASSES_FILE, "CONFIG_MAP");
    expect(hasToken(configMap, "max-md:overflow-x-auto")).toBe(true);
    expect(hasToken(configMap, "max-md:overflow-y-hidden")).toBe(true);
  });
});
