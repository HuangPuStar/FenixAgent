// web/__tests__/agent-home-long-template.test.ts
// 「新建智能体」首页表单承载超长模板提示词时的布局契约守卫：容器不被列 flex 压缩、「返回」区吸顶、
// 提示词域自带滚动边界。
//
// 背景（2026-09-24 现场，用户截图批注「模板太长的时候（第一个模板），上面的东西被遮住了没法点返回」）：
// 模板提示词是几十节 Markdown 的长文档，基础 `Textarea` 带 `field-sizing-content`（随内容长高），
// 一条 90 段的提示词就把文本域撑到 13305px 高；而 `.agent-home-container` 既 `justify-content: center`
// 又默认可被父级列 flex 压缩——容器高被钉死在视口高，溢出内容对称地落到容器上下两侧，滚动容器
// （`.agent-home-page` 的 `overflow: auto`）的可滚动区却只向右下延伸，于是上半部分（品牌区 +
// 表单头部的「返回」）落在 scrollTop=0 之上，既滚不到也点不到。
//
// 实测（headless Chromium 复刻本页 DOM + 构建产物 CSS，两组视口各两类提示词长度）：
//   修复前：返回按钮 top = -6291（90 段）/ -29431（400 段），`elementFromPoint` 命中 null；
//           页面 maxScroll 只覆盖溢出部分的下半段（另一半永远滚不回来）；
//   修复后：scrollTop=0 时 top = 178、按钮中心命中自身；滚到底部时吸顶在 top = 12 仍可点；
//           文本域高恒为 312（长出的内容走自身滚动条），90 段与 400 段读数一致。
//
// 为什么是源码级契约而不是渲染用例（两条都已实证，不是省事）：
//   ① happy-dom 没有布局引擎：`field-sizing-content` 不生效、元素 rect 恒为 0，「被顶出滚动起点」
//      这类几何现象在断言里完全不可见；
//   ② 页面级渲染在 `bun test packages/` 的批量运行里做不了：同进程其它包的文件以 `mock.module`
//      注册进程级替身（`@fenix/ui-components/ui/textarea` 被替成渲染 null——实测批量下表单渲染产物
//      3723 字符中一个 textarea 都没有；`@tanstack/react-router` 被替成只含 `useNavigate` / `Link`
//      的子集，真实 `RouterProvider` 导不进来），而本包禁止自己 mock 模块（`src/__tests__` 的零容忍
//      守卫）。因此几何契约按本包既有做法钉在样式来源上，先例见 `agent-editor-overscroll-chain.test.ts`。
//
// 拦得住：这三条声明被删掉或改回（容器重新可被压缩 / 返回区不再吸顶 / 提示词域不再限高）。
// 拦不住：声明还在但被更高特指度的规则压过、运行时注入的样式，以及真实浏览器里的其余差异
//   （真机读数见 `AGENT_HOME_STYLES` 与 `AgentGenerationForm.tsx` 注释里登记的那两组）。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AGENT_HOME_STYLES } from "../pages/agent-panel/pages/agent-home-styles";

const PAGE_DIR = resolve(import.meta.dir, "../pages/agent-panel/pages");
const COMPONENT_DIR = resolve(import.meta.dir, "../pages/agent-panel/components");

/**
 * 取样式表里某个类选择器的声明块。
 *
 * 解析失败必须抛错：守卫的全部断言都是「块里有没有某条声明」，取到空块会让它们平凡通过。
 * 只处理**顶层**的单类选择器（本页样式表里 `.agent-home-container` / `.agent-home-form-header`
 * 都是顶层类选择器，没有嵌套、没有组合子）。
 */
function declarations(selector: string): string {
  const head = AGENT_HOME_STYLES.indexOf(`${selector} {`);
  if (head < 0) throw new Error(`样式表里找不到 ${selector}`);
  const body = AGENT_HOME_STYLES.slice(head + selector.length + 2);
  const end = body.indexOf("}");
  if (end < 0) throw new Error(`${selector} 的声明块没有闭合`);
  return body.slice(0, end);
}

/** 元素类串按整 token 判定：`max-h-96` 被拼进更长的类名不该算命中。 */
const hasToken = (classes: string, token: string): boolean => classes.split(/\s+/).filter(Boolean).includes(token);
const hasTokenPrefix = (classes: string, prefix: string): boolean =>
  classes
    .split(/\s+/)
    .filter(Boolean)
    .some((token) => token.startsWith(prefix));

/**
 * 取 `AgentGenerationForm.tsx` 里 System Prompt 文本域的类串。
 *
 * 用读源码而不是渲染后取 className：渲染路径会经 `cn`（tailwind-merge）合并基础 `Textarea` 的类串，
 * 而本包的用例在批量运行下拿不到真实 `Textarea`（见文件头理由②）。取不到即抛错，避免守卫空转。
 */
function promptFieldClass(): string {
  const source = readFileSync(join(COMPONENT_DIR, "AgentGenerationForm.tsx"), "utf8");
  const marker = source.indexOf("<Textarea\n            value={systemPrompt}");
  if (marker < 0) throw new Error("找不到 System Prompt 文本域的渲染点");
  const match = source.slice(marker).match(/className="([^"]+)"/);
  if (!match) throw new Error("System Prompt 文本域没有 className");
  return match[1];
}

/** 页面样式表与表单源码都读得到，守卫本身不空转。 */
const FORM_SOURCE = readFileSync(join(COMPONENT_DIR, "AgentGenerationForm.tsx"), "utf8");
const PAGE_DIR_EXISTS = readFileSync(join(PAGE_DIR, "AgentHomePage.tsx"), "utf8");

describe("创建智能体首页承载超长模板提示词的布局契约", () => {
  // 页面仍从本目录读取并渲染样式表与表单：守卫的对象必须在真实渲染路径上，否则它只是在测死文件。
  test("守卫对象挂在真实渲染路径上", () => {
    expect(PAGE_DIR_EXISTS).toContain("<style>{AGENT_HOME_STYLES}</style>");
    expect(PAGE_DIR_EXISTS).toContain("<AgentGenerationForm");
    expect(AGENT_HOME_STYLES.length).toBeGreaterThan(1_000);
    expect(FORM_SOURCE).toContain("value={systemPrompt}");
  });

  // 容器必须同时「居中」（短内容时的版心）与「不可被压缩」（长内容时把滚动交给页面）：
  // 只留居中会让长内容的上半截落到滚动起点之上，正是本次「返回点不到」的形态。
  test("容器保持居中但不可被列 flex 压缩", () => {
    const container = declarations(".agent-home-container");
    expect(container).toContain("justify-content: center");
    expect(container).toContain("flex-shrink: 0");
    expect(container).toContain("min-height: calc(100vh - 56px)");
  });

  // 「返回」是长提示词下唯一的退出口：它必须吸顶并带不透明底色，否则内容会从按钮下穿过。
  test("「返回」区吸顶且不透明，提示词再长也留在视口内", () => {
    const header = declarations(".agent-home-form-header");
    expect(header).toContain("position: sticky");
    expect(header).toContain("top: 0");
    expect(header).toContain("background: #fff");
  });

  // 提示词域限高后长出的内容走自身滚动条：删掉限高，文本域会重新把表单与顶部「返回」一起推走。
  test("提示词域限高并在自身滚动，同时保留自动长高", () => {
    const fieldClass = promptFieldClass();
    expect(hasTokenPrefix(fieldClass, "max-h-")).toBe(true);
    expect(hasToken(fieldClass, "overflow-y-auto")).toBe(true);
    // 短提示词仍按内容长高（基础 Textarea 的 field-sizing-content 未被覆盖掉）
    expect(hasToken(fieldClass, "min-h-28")).toBe(true);
  });
});
