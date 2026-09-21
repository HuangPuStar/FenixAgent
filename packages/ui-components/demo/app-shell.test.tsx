import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "./App";
import { setupDemoI18n } from "./i18n";
import { Providers } from "./providers";

/**
 * demo 侧栏装配的冒烟测试：导航必须按组件层级列全 17 个分区，且每一项都能切出对应的分区内容。
 *
 * 这条断言针对的是「左侧边栏展示错了」这类回归：分区 id 与 i18n 文案键、App.tsx 的分区表、
 * 各分区文件的导出名三者必须一一对应。缺文案会在侧栏渲染出 `sections.<id>` 原始 key，
 * 顺序错乱则说明层级维度的编排被破坏 —— 两者都在这里暴露。
 *
 * 依赖 happy-dom（根 package.json 已声明）：在文件顶部把 window/document 等灌进 globalThis。
 * 与 `chat-smoke.test.tsx`、`non-chat-sections-smoke.test.tsx` 的分工：那两个文件按层验证分区
 * 内容，这里只验证外壳把分区装起来了。
 */

const window = initializeHappyDomWindow(new Window());
// biome-ignore lint/suspicious/noExplicitAny: 测试环境需要把 happy-dom 的 DOM 注入全局
(globalThis as any).window = window;
// biome-ignore lint/suspicious/noExplicitAny: 同上
(globalThis as any).document = window.document;
// biome-ignore lint/suspicious/noExplicitAny: 同上
(globalThis as any).navigator = window.navigator;
// biome-ignore lint/suspicious/noExplicitAny: 同上（与 happy-dom 的 Blob/File 同源）
(globalThis as any).FileReader = window.FileReader;
// biome-ignore lint/suspicious/noExplicitAny: 同上（组件读取元素尺寸）
(globalThis as any).getComputedStyle = window.getComputedStyle.bind(window);
// biome-ignore lint/suspicious/noExplicitAny: 同上
(globalThis as any).ResizeObserver = window.ResizeObserver;
// biome-ignore lint/suspicious/noExplicitAny: 同上
(globalThis as any).HTMLElement = window.HTMLElement;
// biome-ignore lint/suspicious/noExplicitAny: 同上（Resizable 依赖 Node 判断面板元素）
(globalThis as any).Node = window.Node;
// biome-ignore lint/suspicious/noExplicitAny: 同上（Resizable 读取面板尺寸时构造 DOMRect）
(globalThis as any).DOMRect = window.DOMRect;
// biome-ignore lint/suspicious/noExplicitAny: 同上
(globalThis as any).Element = window.Element;
// biome-ignore lint/suspicious/noExplicitAny: 同上（主题切换按钮依赖 matchMedia 与事件）
(globalThis as any).Event = window.Event;
// biome-ignore lint/suspicious/noExplicitAny: 同上
(globalThis as any).MouseEvent = window.MouseEvent;
// biome-ignore lint/suspicious/noExplicitAny: 同上
(globalThis as any).CustomEvent = window.CustomEvent;
// biome-ignore lint/suspicious/noExplicitAny: 同上
(globalThis as any).SVGElement = window.SVGElement;
// biome-ignore lint/suspicious/noExplicitAny: 同上（happy-dom 的 requestAnimationFrame 绑定到它的 window）
(globalThis as any).requestAnimationFrame = window.requestAnimationFrame.bind(window);
// biome-ignore lint/suspicious/noExplicitAny: 同上
(globalThis as any).cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
// biome-ignore lint/suspicious/noExplicitAny: React 19 的 act 环境标记
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

setupDemoI18n();

/** 侧栏的期望全貌：顺序即组件层级顺序（Design Tokens → Base UI → Chat → 各业务域）。 */
const EXPECTED_NAV_LABELS = [
  "Design Tokens",
  "Base UI P1",
  "Base UI P2",
  "Base UI P3",
  "Chat L1",
  "Chat L2",
  "Chat L3",
  "Chat L4",
  "File L1",
  "File L2",
  "Preview L1",
  "Preview L2",
  "Workbench L1",
  "Workbench L2",
  "Data L1",
  "Data L2",
  "Agent L1",
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div") as HTMLDivElement;
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** 按层级顺序读出侧栏条目；限定 .demo-nav 作用域，避免与分区内部的同名按钮混淆。 */
function readNavButtons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>(".demo-nav .demo-nav-item"));
}

function renderApp() {
  // App 依赖 ThemeProvider（ThemeToggle）与 i18n 实例，因此与 main.tsx 一样用 Providers 包裹。
  act(() =>
    root.render(
      <Providers>
        <App />
      </Providers>,
    ),
  );
}

describe("demo shell navigation", () => {
  // 侧栏按层级列出全部 17 个分区，文案全部来自字典（出现 sections.* 原始 key 即说明键缺失）。
  test("lists every section in layer order", () => {
    renderApp();
    expect(readNavButtons().map((button) => button.textContent)).toEqual(EXPECTED_NAV_LABELS);
    expect(container.textContent ?? "").not.toContain("sections.");
  });

  // 默认进入第一个分区（Design Tokens），导航项与内容区标题一致。
  test("opens the first section by default", () => {
    renderApp();
    expect(container.querySelector(".demo-section-title")?.textContent).toBe("Design Tokens");
    expect(readNavButtons()[0]?.getAttribute("data-active")).toBe("true");
  });

  // 点击导航项切换到对应分区：内容区换成该层的分区组件，导航项标记为 active。
  test("switches the active section on click", () => {
    renderApp();
    const target = readNavButtons().find((button) => button.textContent === "File L1");
    expect(target).toBeDefined();
    act(() => target?.click());
    expect(container.querySelector(".demo-section-title")?.textContent).toBe("File L1");
    expect(target?.getAttribute("data-active")).toBe("true");
    expect(readNavButtons()[0]?.getAttribute("data-active")).toBe("false");
  });
});
