import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { initReactI18next } from "react-i18next/initReactI18next";
import type { ThreadEntry, ToolCallStatus } from "../chat/types";
import { ChatView } from "../chat/view/ChatView";
import zh from "../i18n/locales/zh/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";

/**
 * 活动链折叠的交互测试。
 *
 * 契约：运行中默认展开；整条链结束后自动折叠；用户手动切换后以手动状态为准。
 * 折叠时不挂载链内条目（不是仅视觉隐藏）。
 */

const window = initializeHappyDomWindow(new Window());
/* biome-ignore lint/suspicious/noExplicitAny: 测试环境需要把 happy-dom 的 DOM 注入全局 */
(globalThis as any).window = window;
/* biome-ignore lint/suspicious/noExplicitAny: 同上 */
(globalThis as any).document = window.document;
/* biome-ignore lint/suspicious/noExplicitAny: 同上 */
(globalThis as any).navigator = window.navigator;
/* biome-ignore lint/suspicious/noExplicitAny: 同上 */
(globalThis as any).HTMLElement = window.HTMLElement;
/* biome-ignore lint/suspicious/noExplicitAny: use-stick-to-bottom 需要 ResizeObserver */
(globalThis as any).ResizeObserver = window.ResizeObserver;
/* biome-ignore lint/suspicious/noExplicitAny: use-stick-to-bottom 读取布局样式 */
(globalThis as any).getComputedStyle = window.getComputedStyle.bind(window);
/* biome-ignore lint/suspicious/noExplicitAny: 工具行内的 radix Collapsible 依赖 rAF */
(globalThis as any).requestAnimationFrame = window.requestAnimationFrame.bind(window);
/* biome-ignore lint/suspicious/noExplicitAny: 同上 */
(globalThis as any).cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
/* biome-ignore lint/suspicious/noExplicitAny: React 19 的 act 环境标记 */
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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

function entries(status: ToolCallStatus): ThreadEntry[] {
  return [
    { type: "assistant_message", id: "thought-1", chunks: [{ type: "thought", text: "先读文件" }] },
    {
      type: "tool_call",
      toolCall: {
        id: "tool-1",
        title: "Read",
        kind: "read-file",
        status,
        rawInput: { file_path: "src/app.ts" },
      },
    },
  ];
}

describe("活动链折叠", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = window.document.createElement("div") as unknown as HTMLDivElement;
    window.document.body.appendChild(host as unknown as Parameters<typeof window.document.body.appendChild>[0]);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    window.document.body.replaceChildren();
  });

  const toggle = () => host.querySelector<HTMLButtonElement>('[data-slot="chat-activity-chain-toggle"]');
  const body = () => host.querySelector('[data-slot="chat-activity-chain-body"]');

  // 已结束的活动链默认收起，标题保留类别计数，链内工具行不挂载。
  test("完成后的活动链默认折叠", async () => {
    await act(async () => root.render(<ChatView entries={entries("complete")} preWindowed />));

    expect(host.querySelector('[data-slot="chat-activity-chain"]')).not.toBeNull();
    expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
    // 同进程连续跑多个测试文件时，全局 i18n 可能已被别的文件切到英文，故两种语言都接受。
    expect(toggle()?.textContent).toMatch(/读取 1|Read 1/);
    expect(body()).toBeNull();
    expect(host.querySelector('[data-slot="chat-tool-call-row"]')).toBeNull();
  });

  // 展开后链内条目才挂载；再次点击收起。
  test("点击标题展开与收起链内条目", async () => {
    await act(async () => root.render(<ChatView entries={entries("complete")} preWindowed />));

    await act(async () => toggle()?.click());
    expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
    expect(body()).not.toBeNull();
    expect(host.querySelector('[data-slot="chat-tool-call-row"]')).not.toBeNull();
    expect(host.textContent).toContain("app.ts");

    await act(async () => toggle()?.click());
    expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
    expect(body()).toBeNull();
  });

  // 运行中的活动链默认展开，用户能看到正在执行的工具。
  test("运行中的活动链默认展开", async () => {
    await act(async () => root.render(<ChatView entries={entries("running")} isLoading preWindowed />));

    expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
    expect(body()).not.toBeNull();
  });

  // 运行结束且用户从未手动干预时自动折叠。
  test("运行结束后自动折叠", async () => {
    await act(async () => root.render(<ChatView entries={entries("running")} isLoading preWindowed />));
    expect(body()).not.toBeNull();

    await act(async () => root.render(<ChatView entries={entries("complete")} preWindowed />));
    expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
    expect(body()).toBeNull();
  });

  // 用户手动展开后，后续状态变化不得再自动折叠。
  test("用户手动展开后保持展开", async () => {
    await act(async () => root.render(<ChatView entries={entries("complete")} preWindowed />));
    await act(async () => toggle()?.click());
    expect(body()).not.toBeNull();

    const next = entries("complete");
    next.push({
      type: "tool_call",
      toolCall: { id: "tool-2", title: "Grep", kind: "grep", status: "complete" },
    });
    await act(async () => root.render(<ChatView entries={next} preWindowed />));

    expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
    expect(body()).not.toBeNull();
  });
});
