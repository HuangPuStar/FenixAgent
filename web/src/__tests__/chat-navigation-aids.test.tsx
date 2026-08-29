import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PromptJumpRail } from "../../components/chat/chat-navigation-aids";
import type { UserMessageEntry } from "../lib/types";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const window = new Window();
const globalKeys = [
  "document",
  "Element",
  "Event",
  "CustomEvent",
  "HTMLElement",
  "Node",
  "navigator",
  "window",
] as const;
const originalGlobals = new Map(
  globalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const),
);
Object.assign(globalThis, {
  document: window.document,
  Element: window.Element,
  Event: window.Event,
  CustomEvent: window.CustomEvent,
  HTMLElement: window.HTMLElement,
  Node: window.Node,
  navigator: window.navigator,
  window,
});

afterAll(() => {
  for (const key of globalKeys) {
    const descriptor = originalGlobals.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
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
    host = document.createElement("div") as HTMLDivElement;
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  // 超长会话只渲染固定上限的均匀采样刻度，并始终覆盖第一条与最后一条用户输入。
  test("samples long conversations into a bounded prompt index", async () => {
    await act(async () => root.render(<PromptJumpRail entries={entries(80)} />));

    const buttons = [...host.querySelectorAll<HTMLButtonElement>(".chat-prompt-jump-index__item")];
    expect(buttons).toHaveLength(14);
    expect(buttons[0]?.getAttribute("aria-label")).toContain("1/80");
    expect(buttons.at(-1)?.getAttribute("aria-label")).toContain("80/80");
    expect(host.querySelectorAll(".chat-prompt-jump-index__list > li")).toHaveLength(14);
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
    const target = document.getElementById("chat-entry-prompt-1") as HTMLElement;
    const scrollIntoView = mock(() => {});
    target.scrollIntoView = scrollIntoView;
    const button = host.querySelectorAll<HTMLButtonElement>(".chat-prompt-jump-index__item")[1]!;

    await act(async () => button.click());

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    expect(button.getAttribute("aria-current")).toBe("location");
    expect(button.getAttribute("aria-controls")).toBe("chat-entry-prompt-1");
  });
});
