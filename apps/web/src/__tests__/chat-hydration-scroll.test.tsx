// apps/web/src/__tests__/chat-hydration-scroll.test.tsx
// 滚动量化：hydrate 期间不提交内容，内容高度变化不触发滚动风暴；
// 门控完成后一次提交只滚到底一次。用 ResizeObserver mock 主动触发库的布局回调，并统计
// scrollTop > 0 的写入次数。

import { describe, expect, test } from "bun:test";
import type { StructuredMessage } from "@fenix/chat-channel";
import { ChatView } from "@fenix/ui-components/chat/view/ChatView";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { structuredToThreadEntries } from "@fenix/web-runtime/chat/structured-to-thread";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import {
  type ChatHydrationState,
  type UseChatHydrationOptions,
  useChatHydration,
} from "../../../../packages/agent-runtime/web/hooks/use-chat-hydration";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const win = initializeHappyDomWindow(new Window());
const runtimeGlobal = globalThis as Record<string, unknown>;
runtimeGlobal.window = win;
runtimeGlobal.document = win.document;
runtimeGlobal.navigator = win.navigator;
runtimeGlobal.HTMLElement = win.HTMLElement;
runtimeGlobal.getComputedStyle = win.getComputedStyle.bind(win);
runtimeGlobal.requestAnimationFrame =
  win.requestAnimationFrame?.bind(win) ??
  ((callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0));
runtimeGlobal.cancelAnimationFrame = win.cancelAnimationFrame?.bind(win) ?? ((handle: number) => clearTimeout(handle));

let contentHeight = 0;
let scrollWrites = 0;

Object.defineProperty(win.HTMLElement.prototype, "scrollHeight", {
  configurable: true,
  get() {
    return contentHeight;
  },
});
Object.defineProperty(win.HTMLElement.prototype, "clientHeight", {
  configurable: true,
  get() {
    return 500;
  },
});
const scrollTopValues = new WeakMap<object, number>();
Object.defineProperty(win.HTMLElement.prototype, "scrollTop", {
  configurable: true,
  get() {
    return scrollTopValues.get(this) ?? 0;
  },
  set(value: number) {
    if (value > 0) scrollWrites += 1;
    scrollTopValues.set(this, value);
  },
});

interface MockObserver {
  readonly callback: ResizeObserverCallback;
  active: boolean;
}
const observers: MockObserver[] = [];
class MockResizeObserver {
  private readonly entry: MockObserver;
  constructor(callback: ResizeObserverCallback) {
    this.entry = { callback, active: true };
    observers.push(this.entry);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {
    this.entry.active = false;
  }
}
runtimeGlobal.ResizeObserver = MockResizeObserver;

function emitResize(): void {
  for (const observer of observers) {
    if (!observer.active) continue;
    observer.callback(
      [{ contentRect: { height: contentHeight } } as unknown as ResizeObserverEntry],
      {} as ResizeObserver,
    );
  }
}

async function settleAnimation(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 4; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });
}

function assistant(id: string, text: string): StructuredMessage {
  return { type: "assistant_message", id, chunks: [{ type: "message", text }], seq: 0, ts: 0 };
}

function messages(count: number): StructuredMessage[] {
  return Array.from({ length: count }, (_, index) => assistant(`m${index}`, `answer ${index}`));
}

describe("hydrate 滚动次数", () => {
  // 切换会话：回放期间不提交内容，内容高度变化不产生滚动风暴；完成后只滚到底（≤2 次写入）。
  test("hydrate 期间不显示内容且不产生滚动，完成后 1 次", async () => {
    const i18n = createInstance();
    await i18n.init({ lng: "zh", resources: {}, initAsync: false });
    const latest: { current: ChatHydrationState | null } = { current: null };
    let options: UseChatHydrationOptions = {
      scope: "small",
      legacy: [assistant("small", "旧会话")],
      sync: [],
      sourceReady: true,
      liveActive: true,
    };
    function Probe() {
      const hydration = useChatHydration(options);
      latest.current = hydration;
      const entries = structuredToThreadEntries(hydration.messages);
      return createElement(
        I18nextProvider,
        { i18n },
        createElement(ChatView, {
          entries,
          isLoading: hydration.hydrating,
          sessionId: options.scope,
        }),
      );
    }
    const container = win.document.createElement("div") as unknown as HTMLElement;
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(Probe));
    });
    await settleAnimation();

    // 切到大会话：回放期间不展示内容；内容高度为 0（模拟尚未布局）时不得滚动。
    const large = messages(1000);
    contentHeight = 0;
    options = { ...options, scope: "large", legacy: large, liveActive: false, replayActive: true };
    act(() => root.render(createElement(Probe)));
    scrollWrites = 0;
    for (let count = 100; count <= 1000; count += 100) {
      contentHeight = 0;
      emitResize();
      await settleAnimation();
    }
    expect(latest.current?.hydrating).toBe(true);
    expect(latest.current?.messages).toHaveLength(0);
    expect(scrollWrites).toBe(0);

    // 回放完成：一次提交，库只应滚到底一次（允许一次收尾调整）。
    options = { ...options, replayActive: false };
    act(() => root.render(createElement(Probe)));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    contentHeight = 1000 * 40;
    emitResize();
    await settleAnimation();
    expect(latest.current?.hydrating).toBe(false);
    expect(scrollWrites).toBeGreaterThanOrEqual(1);
    expect(scrollWrites).toBeLessThanOrEqual(2);
    act(() => root.unmount());
  }, 30_000);

  // hydrate 中途再切会话：旧会话的计时器与内容都不得产生滚动；新会话完成后只滚一次。
  test("hydrate 中途切会话不产生滚动", async () => {
    const i18n = createInstance();
    await i18n.init({ lng: "zh", resources: {}, initAsync: false });
    let options: UseChatHydrationOptions = {
      scope: "a",
      legacy: messages(400),
      sync: [],
      sourceReady: true,
      replayActive: true,
    };
    const latest: { current: ChatHydrationState | null } = { current: null };
    function Probe() {
      const hydration = useChatHydration(options);
      latest.current = hydration;
      return createElement(
        I18nextProvider,
        { i18n },
        createElement(ChatView, {
          entries: structuredToThreadEntries(hydration.messages),
          isLoading: hydration.hydrating,
          sessionId: options.scope,
        }),
      );
    }
    const container = win.document.createElement("div") as unknown as HTMLElement;
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(Probe));
    });
    contentHeight = 400 * 40;
    emitResize();
    await settleAnimation();
    scrollWrites = 0;

    // 中途切到另一个大会话：hydrate 期间不展示内容，完成前不产生滚动。
    contentHeight = 0;
    options = { ...options, scope: "b", legacy: messages(800) };
    act(() => root.render(createElement(Probe)));
    contentHeight = 0;
    emitResize();
    await settleAnimation();
    expect(latest.current?.messages).toHaveLength(0);
    expect(scrollWrites).toBe(0);

    // 新会话完成：一次提交后滚到底。
    options = { ...options, replayActive: false, liveActive: true };
    act(() => root.render(createElement(Probe)));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    contentHeight = 800 * 40;
    emitResize();
    await settleAnimation();
    expect(scrollWrites).toBeGreaterThanOrEqual(1);
    expect(scrollWrites).toBeLessThanOrEqual(2);
    act(() => root.unmount());
  }, 30_000);
});
