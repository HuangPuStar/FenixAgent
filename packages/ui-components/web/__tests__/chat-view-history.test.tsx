// packages/ui-components/web/__tests__/chat-view-history.test.tsx
// ChatView 历史加载入口的 memo 契约：历史可用性/数量/加载态变化必须触发重渲染，
// 否则按钮会停留在旧状态（加载中仍可点、数量不更新）。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { initReactI18next } from "react-i18next/initReactI18next";
import type { ThreadEntry } from "../chat/types";
import { ChatView } from "../chat/view/ChatView";
import en from "../i18n/locales/en/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";

const window = initializeHappyDomWindow(new Window());
/* biome-ignore lint/suspicious/noExplicitAny: 测试环境需要把 happy-dom 的 DOM 注入全局 */
(globalThis as any).window = window;
/* biome-ignore lint/suspicious/noExplicitAny: 同上 */
(globalThis as any).document = window.document;
/* biome-ignore lint/suspicious/noExplicitAny: 同上 */
(globalThis as any).navigator = window.navigator;
/* biome-ignore lint/suspicious/noExplicitAny: 同上 */
(globalThis as any).HTMLElement = window.HTMLElement;
/* biome-ignore lint/suspicious/noExplicitAny: 同上 */
(globalThis as any).customElements = window.customElements;
/* biome-ignore lint/suspicious/noExplicitAny: 同上（use-stick-to-bottom 需要 ResizeObserver） */
(globalThis as any).ResizeObserver = window.ResizeObserver;
/* biome-ignore lint/suspicious/noExplicitAny: 同上（use-stick-to-bottom 读取布局样式） */
(globalThis as any).getComputedStyle = window.getComputedStyle.bind(window);
/* biome-ignore lint/suspicious/noExplicitAny: React 19 的 act 环境标记 */
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const i18n = createInstance();
void i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  ns: [UI_COMPONENTS_NS],
  defaultNS: UI_COMPONENTS_NS,
  initAsync: false,
  interpolation: { escapeValue: false },
  resources: { en: { [UI_COMPONENTS_NS]: en } },
});

const ENTRIES: ThreadEntry[] = [{ type: "user_message", id: "u-1", content: "hello" }];

interface HistoryProps {
  hasEarlierHistory: boolean;
  earlierMessageCount: number;
  historyLoading: boolean;
}

describe("ChatView 历史加载 memo", () => {
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

  // 历史可用性、隐藏数量与加载态变化必须重渲染；按钮文案/禁用状态是唯一可观察结果。
  test("re-renders the earlier-history entry when availability, count or loading changes", async () => {
    const onLoadEarlierHistory = () => {};
    const render = (props: HistoryProps) =>
      root.render(<ChatView entries={ENTRIES} preWindowed onLoadEarlierHistory={onLoadEarlierHistory} {...props} />);
    const button = () => host.querySelector<HTMLButtonElement>('[data-slot="chat-load-earlier"] button');

    await act(async () => render({ hasEarlierHistory: false, earlierMessageCount: 0, historyLoading: false }));
    expect(host.querySelector('[data-slot="chat-load-earlier"]')).toBeNull();

    await act(async () => render({ hasEarlierHistory: true, earlierMessageCount: 0, historyLoading: false }));
    expect(button()).not.toBeNull();
    expect(button()?.textContent).toBe("Show earlier messages");
    expect(button()?.disabled).toBe(false);

    await act(async () => render({ hasEarlierHistory: true, earlierMessageCount: 2, historyLoading: false }));
    expect(button()?.textContent).toContain("2");

    await act(async () => render({ hasEarlierHistory: true, earlierMessageCount: 5, historyLoading: false }));
    expect(button()?.textContent).toContain("5");

    await act(async () => render({ hasEarlierHistory: true, earlierMessageCount: 5, historyLoading: true }));
    expect(button()?.disabled).toBe(true);
  });

  // 回调引用变化必须触发重渲染：否则按钮仍持有旧闭包，点击加载的是切换前的会话。
  test("re-renders when the earlier-history callback changes", async () => {
    let firstCalls = 0;
    let secondCalls = 0;
    const first = () => {
      firstCalls += 1;
    };
    const second = () => {
      secondCalls += 1;
    };
    const render = (onLoadEarlierHistory: () => void) =>
      root.render(
        <ChatView
          entries={ENTRIES}
          preWindowed
          hasEarlierHistory
          earlierMessageCount={1}
          onLoadEarlierHistory={onLoadEarlierHistory}
        />,
      );
    const click = () => host.querySelector<HTMLButtonElement>('[data-slot="chat-load-earlier"] button')?.click();

    await act(async () => render(first));
    await act(async () => click());
    expect(firstCalls).toBe(1);

    await act(async () => render(second));
    await act(async () => click());
    expect(secondCalls).toBe(1);
    expect(firstCalls).toBe(1);
  });

  // preWindowed 切换必须重渲染：上层可能从“已截断”改为“交给组件窗口”，
  // 漏比会继续按旧模式渲染全部条目或错误裁掉首屏。
  test("re-renders when preWindowed switches", async () => {
    const entries: ThreadEntry[] = Array.from({ length: 101 }, (_, index) => ({
      type: "user_message",
      id: `u-${index}`,
      content: `message ${index}`,
    }));
    const render = (preWindowed: boolean) => root.render(<ChatView entries={entries} preWindowed={preWindowed} />);
    const renderedEntries = () => host.querySelectorAll('[id^="chat-entry-"]').length;

    await act(async () => render(true));
    expect(renderedEntries()).toBe(101);

    await act(async () => render(false));
    expect(renderedEntries()).toBe(100);
  });
});
