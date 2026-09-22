// MessageBubble 复制动作的反馈（2026-09-22 前端去重：原先是裸 `navigator.clipboard.writeText`，
// 失败静默——没有任何可见反馈，用户只会以为「点了没反应」）。
//
// 骨架沿用本包既有的交互用例（`chat-navigation-aids.test.tsx`）：happy-dom 注入 DOM 全局 +
// i18next 实例 + `react-dom/client` 渲染，文案取包内 en 字典。
//
// 覆盖：失败态出现（可见文案 + 红色 + 告警图标）与成功时不出现。失败态的自动回落（2s 定时器）不在
// 这里断言——它靠真实定时器，跑一次要让整个套件多等 2 秒；回落路径短小且无分支，不值得为此引入假定时器。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { initReactI18next } from "react-i18next/initReactI18next";
import type { AssistantMessageEntry } from "../chat/types";
import { AssistantBubble } from "../chat/view/MessageBubble";
import en from "../i18n/locales/en/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";

const window = initializeHappyDomWindow(new Window());
/* biome-ignore lint/suspicious/noExplicitAny: 测试环境需要把 happy-dom 的 DOM 注入全局 */
(globalThis as any).window = window;
/* biome-ignore lint/suspicious/noExplicitAny: 同上 */
(globalThis as any).document = window.document;
/* biome-ignore lint/suspicious/noExplicitAny: 同上（`lib/clipboard` 读的是 `globalThis.navigator`） */
(globalThis as any).navigator = window.navigator;
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

const ENTRY: AssistantMessageEntry = {
  type: "assistant_message",
  id: "a1",
  chunks: [{ type: "message", text: "正文" }],
};

/** 换掉 happy-dom 的 `navigator.clipboard`；用例结束由 `afterEach` 还原成「无剪贴板」。 */
function stubClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
}

describe("AssistantBubble 复制动作", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperty(window.navigator, "clipboard", { value: undefined, configurable: true });
    host = window.document.createElement("div") as unknown as HTMLDivElement;
    // happy-dom 的 appendChild 要求同源 Node 类型（与 DOM lib 的 Node 声明不同名）
    window.document.body.appendChild(host as unknown as Parameters<typeof window.document.body.appendChild>[0]);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    window.document.body.replaceChildren();
  });

  function copyButton(): HTMLButtonElement {
    const button = host.querySelector<HTMLButtonElement>("button[aria-label]");
    if (!button) throw new Error("操作条里没有复制按钮");
    return button;
  }

  // 剪贴板缺席（非安全上下文且宿主未装降级）与写入被拒是同一形态：原语回传 false，界面必须说话。
  test("写入失败：按钮转为可见失败态（文案 + 配色 + 图标）", async () => {
    stubClipboard(() => Promise.reject(new Error("NotAllowedError")));
    await act(async () => root.render(<AssistantBubble entry={ENTRY} />));
    expect(copyButton().getAttribute("aria-label")).toBe("Copy");

    await act(async () => copyButton().click());

    const failed = copyButton();
    expect(failed.getAttribute("aria-label")).toBe("Copy failed");
    expect(failed.getAttribute("title")).toBe("Copy failed");
    expect(failed.className).toContain("text-red-600");
    // 图标换成告警（成功时是复制图标）——图标是本操作条唯一的视觉信号。
    expect(failed.querySelector("svg.lucide-triangle-alert")).not.toBeNull();
  });

  test("剪贴板 API 缺失：同样给失败反馈", async () => {
    Object.defineProperty(window.navigator, "clipboard", { value: undefined, configurable: true });
    await act(async () => root.render(<AssistantBubble entry={ENTRY} />));

    await act(async () => copyButton().click());

    expect(copyButton().getAttribute("aria-label")).toBe("Copy failed");
  });

  test("写入成功：不出现失败态，按钮回到复制语义", async () => {
    const written: string[] = [];
    stubClipboard(async (text) => {
      written.push(text);
    });
    await act(async () => root.render(<AssistantBubble entry={ENTRY} />));

    await act(async () => copyButton().click());

    expect(written).toEqual(["正文"]);
    const button = copyButton();
    expect(button.getAttribute("aria-label")).toBe("Copy");
    expect(button.className).not.toContain("text-red-600");
    expect(button.querySelector("svg.lucide-triangle-alert")).toBeNull();
  });
});
