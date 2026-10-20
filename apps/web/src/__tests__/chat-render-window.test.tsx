// apps/web/src/__tests__/chat-render-window.test.tsx
// 大基线渲染窗口：默认只挂载最近 100 条，点击“显示更早”后增加 300 条，DOM 数量有界。

import { describe, expect, test } from "bun:test";
import type { ThreadEntry } from "@fenix/ui-components/chat/types";
import { ChatView } from "@fenix/ui-components/chat/view/ChatView";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { useChatMessageWindow } from "../../../../packages/ui-components/web/chat/view/chat-render-window";

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
  // 1200 条默认只渲染最近 100 条；加载更早后增加 300 条。
  test("默认窗口 100 条，加载更早后增加 300 条", async () => {
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
    expect(container.querySelectorAll('[data-slot="chat-user-message-frame"]')).toHaveLength(100);

    const loadEarlier = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("chat.components.chatView.loadEarlier"),
    );
    expect(loadEarlier).toBeDefined();
    await act(async () => {
      loadEarlier?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event);
    });
    expect(container.querySelectorAll('[data-slot="chat-user-message-frame"]')).toHaveLength(400);
    act(() => root.unmount());
  });

  // 协议层还有更早历史时，即使 ChatView 自身已经没有隐藏条目，也必须保留“显示更早”入口并调用外部加载。
  test("协议层更早历史触发外部加载入口", async () => {
    const i18n = createInstance();
    await i18n.init({ lng: "zh", resources: {}, initAsync: false });
    let externalLoads = 0;
    const container = win.document.createElement("div") as unknown as HTMLElement;
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(ChatView, {
            entries: userEntries(100),
            isLoading: false,
            hasEarlierHistory: true,
            onLoadEarlierHistory: () => {
              externalLoads += 1;
            },
          }),
        ),
      );
    });
    const loadEarlier = container.querySelector('[data-slot="chat-load-earlier"] button');
    expect(loadEarlier).not.toBeNull();
    await act(async () => {
      loadEarlier?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event);
    });
    expect(externalLoads).toBe(1);
    act(() => root.unmount());
  });
});

describe("数据层历史窗口", () => {
  // 首屏只暴露最近 100 条；显示更早逐批扩大 300 条；换代键变化立即回到首屏窗口。
  test("首屏 100 条、加载更早每批 300 条、换代重置", async () => {
    const messages = userEntries(600);
    const container = win.document.createElement("div") as unknown as HTMLElement;
    const root = createRoot(container);

    function Probe({ scope, items }: { scope: string; items: readonly ThreadEntry[] }) {
      const window = useChatMessageWindow(items, scope);
      return createElement(
        "div",
        null,
        createElement("span", { id: "visible" }, String(window.visible.length)),
        createElement("span", { id: "hidden" }, String(window.hiddenCount)),
        createElement("button", { id: "load", onClick: window.loadEarlier }, "load"),
      );
    }

    await act(async () => {
      root.render(createElement(Probe, { scope: "a", items: messages }));
    });
    expect(container.querySelector("#visible")?.textContent).toBe("100");
    expect(container.querySelector("#hidden")?.textContent).toBe("500");

    await act(async () => {
      container
        .querySelector("#load")
        ?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event);
    });
    expect(container.querySelector("#visible")?.textContent).toBe("400");

    await act(async () => {
      root.render(createElement(Probe, { scope: "b", items: messages.slice(0, 5) }));
    });
    expect(container.querySelector("#visible")?.textContent).toBe("5");
    expect(container.querySelector("#hidden")?.textContent).toBe("0");
    act(() => root.unmount());
  });
});
