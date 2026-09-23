import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { initReactI18next } from "react-i18next/initReactI18next";
import type { UserMessageEntry } from "../chat/types";
import { PromptJumpRail } from "../chat/view/chat-navigation-aids";
import en from "../i18n/locales/en/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";

/**
 * 会话导航辅助组件（`web/chat/view/chat-navigation-aids.tsx`，`PromptJumpRail`）的行为测试。
 *
 * 覆盖范围是纯化后的导航契约：长会话刻度采样上限、system-reminder 的过滤、单条真实输入的隐藏，
 * 以及与 `ChatView` 消息节点（`chat-entry-<entryId>`）的点击定位/高亮联动。
 * 文案断言取「包内字典里的译文，字典尚未搬运时回落 key」，避免集成阶段补 i18n 后测试失真。
 */

const window = initializeHappyDomWindow(new Window());
/* biome-ignore lint/suspicious/noExplicitAny: 测试环境需要把 happy-dom 的 DOM 注入全局 */
(globalThis as any).window = window;
/* biome-ignore lint/suspicious/noExplicitAny: 同上 */
(globalThis as any).document = window.document;
/* biome-ignore lint/suspicious/noExplicitAny: 同上 */
(globalThis as any).navigator = window.navigator;
/* biome-ignore lint/suspicious/noExplicitAny: 同上（FileReader 必须与 happy-dom 的 Blob 同源） */
(globalThis as any).FileReader = window.FileReader;
/* biome-ignore lint/suspicious/noExplicitAny: 同上（组件用 `element instanceof HTMLElement` 判定滚动层） */
(globalThis as any).HTMLElement = window.HTMLElement;
/* biome-ignore lint/suspicious/noExplicitAny: 同上（streamdown 的 diff 组件按 `customElements.get` 判定自定义元素） */
(globalThis as any).customElements = window.customElements;
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

function entries(count: number): UserMessageEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    type: "user_message",
    id: `prompt-${index}`,
    content: `第 ${index + 1} 条用户输入`,
  }));
}

describe("PromptJumpRail", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = window.document.createElement("div") as unknown as HTMLDivElement;
    // happy-dom 的 appendChild 要求同源 Node 类型（与 DOM lib 的 Node 声明不同名）
    window.document.body.appendChild(host as unknown as Parameters<typeof window.document.body.appendChild>[0]);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    window.document.body.replaceChildren();
  });

  // 超长会话只渲染固定上限的均匀采样刻度，并始终覆盖第一条与最后一条用户输入。
  test("samples long conversations into a bounded prompt index", async () => {
    await act(async () => root.render(<PromptJumpRail entries={entries(80)} />));

    const buttons = [...host.querySelectorAll<HTMLButtonElement>('[data-slot="chat-prompt-jump-item"]')];
    expect(buttons).toHaveLength(14);
    expect(buttons[0]?.getAttribute("aria-label")).toContain("1/80");
    expect(buttons.at(-1)?.getAttribute("aria-label")).toContain("80/80");
    expect(host.querySelectorAll('[data-slot="chat-prompt-jump-list"] > li')).toHaveLength(14);
  });

  // system-reminder 是系统注入消息，不应占用左侧用户提示词导航的序号和刻度。
  test("excludes system reminders from the prompt index", async () => {
    const promptEntries: UserMessageEntry[] = [
      entries(1)[0]!,
      {
        type: "user_message",
        id: "system-reminder",
        content: "  <system-reminder>\nMCP: 1 connected\n</system-reminder>",
      },
      { ...entries(1)[0]!, id: "prompt-1", content: "第二条用户输入" },
    ];

    await act(async () => root.render(<PromptJumpRail entries={promptEntries} />));

    const buttons = [...host.querySelectorAll<HTMLButtonElement>('[data-slot="chat-prompt-jump-item"]')];
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.getAttribute("aria-label")).toContain("1/2");
    expect(buttons[1]?.getAttribute("aria-label")).toContain("2/2");
    expect(host.textContent).not.toContain("system-reminder");
  });

  // system-reminder 是系统注入消息；过滤后仅有一条真实输入时无需展示跳转导航。
  test("hides the prompt index for one real prompt plus system reminders", async () => {
    const promptEntries: UserMessageEntry[] = [
      entries(1)[0]!,
      {
        type: "user_message",
        id: "system-reminder",
        content: "<system-reminder>\nMCP: 1 connected\n</system-reminder>",
      },
    ];

    await act(async () => root.render(<PromptJumpRail entries={promptEntries} />));

    expect(host.querySelector('[data-slot="chat-prompt-jump-rail"]')).toBeNull();
  });

  // 点击刻度沿用浏览器平滑定位，不修改会话消息或 Conversation 的滚动实现。
  test("smoothly jumps to the selected user prompt", async () => {
    const promptEntries = entries(3);
    await act(async () =>
      root.render(
        <div>
          <PromptJumpRail entries={promptEntries} />
          {promptEntries.map((entry) => (
            <article key={entry.id} id={`chat-entry-${entry.id}`} />
          ))}
        </div>,
      ),
    );
    // happy-dom 的 getElementById 返回其自有 Element 类型（与 DOM lib 声明不同名）
    const target = window.document.getElementById("chat-entry-prompt-1") as unknown as HTMLElement;
    const scrollIntoView = mock(() => {});
    target.scrollIntoView = scrollIntoView as unknown as typeof target.scrollIntoView;
    const button = host.querySelectorAll<HTMLButtonElement>('[data-slot="chat-prompt-jump-item"]')[1]!;

    await act(async () => button.click());

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    expect(button.getAttribute("aria-current")).toBe("location");
    expect(button.getAttribute("aria-controls")).toBe("chat-entry-prompt-1");
    // 高亮由 `data-active-prompt` 属性承担（原 `chat-entry--active-prompt` 类名已随样式迁移删除）。
    expect(target.hasAttribute("data-active-prompt")).toBe(true);
    expect(window.document.getElementById("chat-entry-prompt-0")?.hasAttribute("data-active-prompt")).toBe(false);
  });
});
