// 加载指示器（阶段文字 + 流光条）的行为与样式契约。
//
// 覆盖三件事：
// 1. 阶段文字确实由真实状态派生 —— 末条条目类型 + `isLoading`，不编造阶段；
// 2. 指示器在 loading → 完成之间随 `isLoading` 挂载／卸载；
// 3. 蓝色方块缺陷的写法不得回流（文字渐变 + `background-clip: text` 的任意属性组合），
//    以及减弱动效下仍有静态可读状态。
//
// 与包内其他 chat 用例同款：`renderToStaticMarkup` + `initReactI18next` 登记默认实例，
// 不触碰 DOM API，因此不需要 happy-dom 引导。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInstance } from "i18next";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { initReactI18next } from "react-i18next/initReactI18next";
import type { ThreadEntry } from "../chat/types";
import { ChatView } from "../chat/view/ChatView";
import zh from "../i18n/locales/zh/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";
import { CHAT_DIR, classTokens } from "./chat-style-migration-helpers";

const i18n = createInstance();
void i18n.use(initReactI18next).init({
  lng: "zh",
  fallbackLng: "zh",
  ns: [UI_COMPONENTS_NS],
  defaultNS: UI_COMPONENTS_NS,
  initAsync: false,
  interpolation: { escapeValue: false },
  resources: { zh: { [UI_COMPONENTS_NS]: zh } },
});

const USER: ThreadEntry = { type: "user_message", id: "u-1", content: "帮我看看这个报错" };
const ASSISTANT: ThreadEntry = {
  type: "assistant_message",
  id: "a-1",
  chunks: [{ type: "message", text: "先读一下文件" }],
};
const TOOL: ThreadEntry = {
  type: "tool_call",
  toolCall: { id: "t-1", title: "Read", kind: "read-file", status: "running" },
};
/** 末条是 plan：拿不到「正在做什么」的可靠信号，只能落到通用文案。 */
const PLAN: ThreadEntry = { type: "plan", id: "p-1", entries: [] };

/** 渲染一条时间线的加载态（zh 字典）并返回静态标记。 */
function renderLoading(entries: ThreadEntry[], isLoading = true): string {
  return renderToStaticMarkup(createElement(ChatView, { entries, isLoading }));
}

/** 读取 chat 组件自身的（非 `chat/css/` 聚合入口下的）样式表原文，供静态断言用。 */
function readChatSource(relPath: string): string {
  return readFileSync(join(CHAT_DIR, relPath), "utf8");
}

describe("chat 加载指示器：阶段文字", () => {
  // 四个阶段各对应一种真实状态。末条条目类型是唯一可用的阶段信号（`isLoading` 只回答「在不在跑」），
  // 因此每条断言都必须由 entries 驱动，而不是由组件自己数秒。
  test("末条 user_message → 本轮尚无产出，显示正在思考", () => {
    expect(renderLoading([USER])).toContain("正在思考");
  });

  test("末条 assistant_message → 助手正在产出，显示正在生成", () => {
    expect(renderLoading([USER, ASSISTANT])).toContain("正在生成");
  });

  test("末条 tool_call → 工具刚发起或仍在跑，显示正在调用工具", () => {
    expect(renderLoading([USER, ASSISTANT, TOOL])).toContain("正在调用工具");
  });

  // 无可靠信号时不猜阶段：plan 条目（以及列表为空）退回通用文案。
  test("末条 plan → 无可靠信号，退回通用文案", () => {
    const html = renderLoading([USER, PLAN]);
    expect(html).toContain("正在处理");
    expect(html).not.toContain("正在调用工具");
  });

  test("阶段文案随末条条目类型切换，不是恒定文案", () => {
    const thinking = renderLoading([USER]);
    const callingTool = renderLoading([USER, TOOL]);
    expect(thinking).not.toBe(callingTool);
  });
});

describe("chat 加载指示器：loading → 完成", () => {
  // 指示器只在 loading 期间存在；完成态必须完全卸载（不能留下一条空转的动画）。
  test("loading 结束（isLoading=false）后指示器整体卸载", () => {
    const loading = renderLoading([USER, ASSISTANT], true);
    const done = renderLoading([USER, ASSISTANT], false);

    expect(loading).toContain('role="status"');
    expect(loading).toContain("chat-loading-beam");
    expect(done).not.toContain('role="status"');
    expect(done).not.toContain("chat-loading-beam");
    expect(done).not.toContain("正在生成");
  });

  // 空时间线（无任何条目）时 ChatView 渲染的是空状态/工牌骨架，不渲染本指示器。
  test("无条目时不渲染阶段文字", () => {
    expect(renderLoading([], true)).not.toContain("正在处理");
  });
});

describe("chat 加载指示器：流光条与无障碍", () => {
  // 文字是状态语义的载体，光带是纯装饰：读屏播报阶段文案，不播报光带。
  test("阶段文字由 role=status 播报，光带对读屏隐藏", () => {
    const html = renderLoading([USER, TOOL]);

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-hidden="true"');
  });

  // 颜色与几何全部走 token / 刻度，且有裁切容器包住光带（光带扫出轨道后不可见）。
  test("轨道与光带只用主题 token 与标准刻度", () => {
    const tokens = classTokens(renderLoading([USER, TOOL]));

    expect(tokens).toContain("chat-loading-beam");
    expect(tokens).toContain("bg-surface-3");
    expect(tokens).toContain("overflow-hidden");
    expect(tokens).toContain("h-0.5");
    expect(tokens).toContain("w-1/3");
    expect(tokens).toContain("via-brand-light");
    // 光带不裁切文字：回到「文字渐变 + background-clip」就正是蓝色方块缺陷的写法。
    expect(tokens).not.toContain("bg-clip-text");
    expect(tokens).not.toContain("text-transparent");
  });

  // 减弱动效：扫光关闭，但光带本身仍在（静态点亮态），阶段文字不受影响。
  test("prefers-reduced-motion 下保留静态可读状态", () => {
    const chatViewCss = readChatSource("view/ChatView.css");
    // 取**最后一个** `@media (prefers-reduced-motion: reduce)`：文件里还有一条给提示词高亮闪动的，
    // 而 `.chat-loading-beam` 的基础规则在两者之前，从第一条切会切到基础规则上。
    const reducedMotion = chatViewCss.slice(chatViewCss.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
    const beamStart = reducedMotion.indexOf(".chat-loading-beam");
    const beamBlock = reducedMotion.slice(beamStart, reducedMotion.indexOf("}", beamStart));

    expect(chatViewCss).toContain("animation: chat-loading-sweep 1.8s ease-in-out infinite");
    expect(beamBlock).toContain("animation: none");
    // 关掉动画后光带仍停在轨道内（否则会缩回左端，看着像进度条卡在 0）。
    expect(beamBlock).toContain("translateX(100%)");
    // 阶段文字不依赖动画，减弱动效下依旧可读——指示器本身没有被整体隐藏。
    expect(chatViewCss).not.toContain(".chat-loading-indicator");
  });

  // 扫光按名引用关键帧：`chat-animations.css` 是包内唯一的关键帧定义处，改名必须两侧同步。
  test("扫光关键帧在关键帧文件内声明", () => {
    const animations = readChatSource("css/chat-animations.css");
    expect(animations).toContain("@keyframes chat-loading-sweep");
  });

  // 缺陷根因守卫：蓝色方块来自「文字渐变 + `background-clip: text`」拆成任意属性工具类——
  // `[background:…]` 简写在 `@layer utilities` 里排在 `bg-clip-text` / `[background-size:…]` 之后，
  // 简写把 `background-clip` 复位成 `border-box`，渐变于是铺满整个行内盒，文字因 `text-transparent`
  // 不可见。该组合不得以任何形式回流到加载指示器的源码里。
  test("文字渐变 + 裁切文字的写法不得回流", () => {
    const source = readFileSync(join(CHAT_DIR, "view/ChatView.tsx"), "utf8");

    expect(source).not.toContain("[background:linear-gradient");
    expect(source).not.toContain("bg-clip-text");
    expect(source).not.toContain("-webkit-background-clip");
    expect(source).not.toContain("chat-loading-shimmer");
  });
});
