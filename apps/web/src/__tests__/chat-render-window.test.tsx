// apps/web/src/__tests__/chat-render-window.test.tsx
// 大基线渲染窗口：默认只挂载最近 1000 条，点击“显示更早”后增加 1000 条，DOM 数量有界。

import { describe, expect, test } from "bun:test";
import type { ThreadEntry } from "@fenix/ui-components/chat/types";
import { ChatView } from "@fenix/ui-components/chat/view/ChatView";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const win = initializeHappyDomWindow(new Window());
const runtimeGlobal = globalThis as Record<string, unknown>;
runtimeGlobal.window = win;
runtimeGlobal.document = win.document;
runtimeGlobal.navigator = win.navigator;
runtimeGlobal.HTMLElement = win.HTMLElement;
runtimeGlobal.getComputedStyle = win.getComputedStyle.bind(win);
runtimeGlobal.ResizeObserver =
  win.ResizeObserver ??
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };

function userEntries(count: number): ThreadEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    type: "user_message",
    id: `u${index}`,
    content: `消息 ${index}`,
    ts: index,
    seq: index,
  }));
}

describe("大基线渲染窗口", () => {
  // 1200 条默认只渲染最近 1000 条；加载更早后全部 1200 条可见。
  test("默认窗口 1000 条，加载更早后增加", async () => {
    const i18n = createInstance();
    await i18n.init({ lng: "zh", resources: {}, initAsync: false });
    const container = win.document.createElement("div") as unknown as HTMLElement;
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(ChatView, { entries: userEntries(1200), isLoading: false }),
        ),
      );
    });
    expect(container.querySelectorAll('[data-slot="chat-user-message-frame"]')).toHaveLength(1000);

    const loadEarlier = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("chat.components.chatView.loadEarlier"),
    );
    expect(loadEarlier).toBeDefined();
    await act(async () => {
      loadEarlier?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event);
    });
    expect(container.querySelectorAll('[data-slot="chat-user-message-frame"]')).toHaveLength(1200);
    act(() => root.unmount());
  });
});
