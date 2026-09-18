import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { setupDemoI18n } from "./i18n";
import { ChatSection } from "./sections/chat";

/**
 * demo chat 分区的冒烟测试：在无宿主环境下渲染整段示例，并验证三条关键交互链路
 * —— 权限应答、外部注入提示词后发送、以及文案确实取自包内字典而非回落的 key。
 *
 * 与 `web/__tests__/mock-chat-store.test.tsx` 的分工：那边测 mock 与真实组件的契约，
 * 这边只保证 demo 分区本身可渲染、可交互，mock 的 props 契约漂移会在那边先暴露。
 * 依赖 happy-dom（根 package.json 已声明）：在文件顶部把 window/document 等灌进 globalThis。
 */

const window = new Window();
// biome-ignore lint/suspicious/noExplicitAny: 测试环境需要把 happy-dom 的 DOM 注入全局
(globalThis as any).window = window;
// biome-ignore lint/suspicious/noExplicitAny: 同上
(globalThis as any).document = window.document;
// biome-ignore lint/suspicious/noExplicitAny: 同上
(globalThis as any).navigator = window.navigator;
// biome-ignore lint/suspicious/noExplicitAny: 同上（与 happy-dom 的 Blob/File 同源）
(globalThis as any).FileReader = window.FileReader;
// biome-ignore lint/suspicious/noExplicitAny: 同上（chat 组件依赖的浏览器全局）
(globalThis as any).getComputedStyle = window.getComputedStyle.bind(window);
// biome-ignore lint/suspicious/noExplicitAny: 同上
(globalThis as any).ResizeObserver = window.ResizeObserver;
// biome-ignore lint/suspicious/noExplicitAny: 同上
(globalThis as any).HTMLElement = window.HTMLElement;
// biome-ignore lint/suspicious/noExplicitAny: 同上
(globalThis as any).requestAnimationFrame = window.requestAnimationFrame.bind(window);
// biome-ignore lint/suspicious/noExplicitAny: 同上
(globalThis as any).cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
// biome-ignore lint/suspicious/noExplicitAny: React 19 的 act 环境标记
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

setupDemoI18n();

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

describe("demo chat section", () => {
  // 渲染整个 chat 分区，验证各组示例在无宿主环境下不抛错且产出真实文案。
  test("renders every example group", () => {
    try {
      act(() => root.render(<ChatSection />));
    } catch (error) {
      const aggregated = error as AggregateError;
      for (const inner of aggregated.errors ?? []) console.error("RENDER ERROR:", inner);
      throw error;
    }
    const text = container.textContent ?? "";
    expect(text).toContain("Chat");
    expect(text).toContain("ChatView");
    expect(text).toContain("ToolCallGroup");
    expect(text).toContain("ChatComposer");
    expect(text).toContain("PermissionPanel");
    expect(text).toContain("ACPMain");
  });

  // 渲染后断言若干交互件的实际文案来自包内字典（而非回落的 key）。
  test("renders translated copy", () => {
    act(() => root.render(<ChatSection />));
    const text = container.textContent ?? "";
    expect(text).not.toContain("chat.components.");
    expect(text).not.toContain("chat.toolNarrator.");
  });

  // 权限应答：点击「允许一次」后请求从内存快照移除，面板与提示行同步变化。
  test("responding to a permission removes the card", () => {
    act(() => root.render(<ChatSection />));
    expect(container.textContent).toContain("Permission required");
    const allowButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("允许一次"),
    );
    expect(allowButton).toBeDefined();
    act(() => allowButton?.click());
    expect(container.textContent).toContain("权限已应答");
  });

  // 输入岛发送：通过 subscribeExternal 注入草稿后点击发送按钮，回调结果写回提示行。
  test("injected prompt + send button submits", () => {
    act(() => root.render(<ChatSection />));
    const injectButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("注入建议提示词"),
    );
    expect(injectButton).toBeDefined();
    act(() => injectButton?.click());
    const textareas = Array.from(container.querySelectorAll("textarea"));
    const draft = textareas.find((textarea) => textarea.value.includes("onPreviewFile"));
    expect(draft).toBeDefined();
    const send = container.querySelector(".chat-composer-send");
    expect(send).toBeDefined();
    act(() => (send as unknown as HTMLButtonElement).click());
    expect(container.textContent).toContain("已提交：用一句话说明 onPreviewFile 的宿主契约");
  });
});
