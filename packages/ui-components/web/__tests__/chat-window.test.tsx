import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { initReactI18next } from "react-i18next/initReactI18next";
import type { ThreadEntry } from "../chat/types";
import { ChatView } from "../chat/view/ChatView";
import { CHAT_BLOCK_INDEX_ATTRIBUTE, CHAT_WINDOW_ENTRY_BUDGET } from "../chat/view/internal/chat-window";
import en from "../i18n/locales/en/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";

/**
 * 时间线渲染滑动窗口的接线测试（`web/chat/view/internal/*` 挂在 `ChatView` 上的实际行为）。
 *
 * 窗口的数学与滑动意图在 `chat-window-pure.test.ts` 覆盖；这里只验证**渲染层的接缝**：
 * 1. 超长会话只进约 100 条 DOM，且首尾都是完整条目（边缘不截断）；
 * 2. 滚动到顶部会滑入更早的条目，并把 `scrollTop` 按锚点补偿回原位（可见区域不跳动）；
 * 3. 有进行中的响应时最新条目始终留在窗口内（流式条目不滑出）；
 * 4. 窗口外条目的更新不丢：滑进来时呈现的是最新内容，且同一条只出现一次。
 *
 * happy-dom 没有布局，因此这里自带一套**合成布局**：每个渲染块高 100px、按 DOM 顺序排布、
 * 减去 `scrollTop`，滚动区高度 = 块数 × 100。窗口的锚定补偿读的正是这两个量（块的视口 top、视口高度），
 * 合成布局因此足以驱动真实的补偿路径，而不是把被测量的行为替换成断言常量。
 */

const window = initializeHappyDomWindow(new Window());
/* biome-ignore lint/suspicious/noExplicitAny: 测试环境需要把 happy-dom 的 DOM 注入全局 */
(globalThis as any).window = window;
/* biome-ignore lint/suspicious/noExplicitAny: 同上 */
(globalThis as any).document = window.document;
/* biome-ignore lint/suspicious/noExplicitAny: 同上 */
(globalThis as any).navigator = window.navigator;
/* biome-ignore lint/suspicious/noExplicitAny: 同上（与 happy-dom 的 Blob/File 同源） */
(globalThis as any).FileReader = window.FileReader;
/* biome-ignore lint/suspicious/noExplicitAny: 同上（组件用 `element instanceof HTMLElement` 判定滚动层） */
(globalThis as any).HTMLElement = window.HTMLElement;
/* biome-ignore lint/suspicious/noExplicitAny: 同上（streamdown 的 diff 组件按 `customElements.get` 判定自定义元素） */
(globalThis as any).customElements = window.customElements;
/* biome-ignore lint/suspicious/noExplicitAny: 同上（`use-stick-to-bottom` 读滚动层的 overflow 与内容尺寸） */
(globalThis as any).getComputedStyle = window.getComputedStyle.bind(window);
/* biome-ignore lint/suspicious/noExplicitAny: 同上 */
(globalThis as any).ResizeObserver = window.ResizeObserver;
/* biome-ignore lint/suspicious/noExplicitAny: 同上（窗口的滚动监听按 happy-dom 的 rAF 节流） */
(globalThis as any).requestAnimationFrame = window.requestAnimationFrame.bind(window);
/* biome-ignore lint/suspicious/noExplicitAny: 同上 */
(globalThis as any).cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
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

/** 合成布局参数：块高与视口高。滚动区高度由块数推导，窗口滑动时随之变化。 */
const BLOCK_HEIGHT = 100;
const VIEWPORT_HEIGHT = 600;

let layoutScroller: HTMLElement | null = null;
const originalGetBoundingClientRect = window.Element.prototype.getBoundingClientRect;

function promptEntry(index: number, content = `第 ${index} 条输入`): ThreadEntry {
  return { type: "user_message", id: `u-${index}`, content };
}

/** 全部为用户消息的时间线：每条各占一个渲染块，块下标与条目下标一一对应，断言更直接。 */
function prompts(count: number, override: (index: number) => string | undefined = () => undefined): ThreadEntry[] {
  return Array.from({ length: count }, (_, index) => promptEntry(index, override(index)));
}

/**
 * 压测式长会话：常规轮次 + 尾部一长串连续工具调用。
 *
 * 相邻工具调用会被渲染布局并成**一个** `tool_group`（一个块覆盖数千条目）——正是「首次进入像
 * 全量加载」的输入形态：块粒度预算遇到这种块会整体收下。
 */
function stressSession(turns = 40, perTurn = 15, tailTools = 3956): ThreadEntry[] {
  const entries: ThreadEntry[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    entries.push(promptEntry(turn));
    entries.push({
      type: "assistant_message",
      id: `a-${turn}`,
      chunks: [{ type: "message", text: `第 ${turn} 轮回复` }],
    });
    for (let index = 0; index < perTurn; index += 1) {
      entries.push({
        type: "tool_call",
        toolCall: { id: `t-${turn}-${index}`, title: "Read", kind: "read-file", status: "complete" },
      });
    }
  }
  for (let index = 0; index < tailTools; index += 1) {
    entries.push({
      type: "tool_call",
      toolCall: { id: `tail-${index}`, title: "Read", kind: "read-file", status: "complete" },
    });
  }
  return entries;
}

/** 滚动区（`ConversationContent` 的父元素，即 `use-stick-to-bottom` 的 scroll 元素）。 */
function scrollerOf(host: HTMLElement): HTMLElement {
  const content = host.querySelector('[data-slot="chat-conversation-content"]');
  if (!content?.parentElement) throw new Error("conversation content not found");
  return content.parentElement as HTMLElement;
}

/** 已渲染的条目 id（只有条目节点带 `chat-entry-` id，加载指示器与滚动按钮不参与）。 */
function renderedEntryIds(host: HTMLElement): string[] {
  return [...host.querySelectorAll<HTMLElement>('[id^="chat-entry-"]')].map((element) =>
    element.id.replace("chat-entry-", ""),
  );
}

/** 装上合成布局：视口高固定，滚动区高度随渲染块数变化。 */
function installSyntheticLayout(scroller: HTMLElement): void {
  layoutScroller = scroller;
  Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => VIEWPORT_HEIGHT });
  Object.defineProperty(scroller, "scrollHeight", {
    configurable: true,
    get: () => scroller.querySelectorAll(`[${CHAT_BLOCK_INDEX_ATTRIBUTE}]`).length * BLOCK_HEIGHT,
  });
}

/**
 * 把滚动位置推到目标值并触发一次滚动，随后等窗口 hook 的 rAF 判定落地。
 *
 * `scrollTop` 必须在 `act` 内写：happy-dom 会为这次写入异步补派一个 scroll 事件，写在 act 之外
 * 会让 `use-stick-to-bottom` 的贴底状态更新落在 act 之外（警告且不可靠）。
 */
async function scrollTo(scroller: HTMLElement, target: number | (() => number)): Promise<void> {
  await act(async () => {
    scroller.scrollTop = typeof target === "function" ? target() : target;
    scroller.dispatchEvent(new window.Event("scroll"));
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

describe("ChatView 时间线滑动窗口", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = window.document.createElement("div") as unknown as HTMLDivElement;
    window.document.body.appendChild(host as unknown as Parameters<typeof window.document.body.appendChild>[0]);
    root = createRoot(host);
    // 块的视口位置按「DOM 顺序 × 块高 − scrollTop」合成：与真实布局在固定块高下同构。
    window.Element.prototype.getBoundingClientRect = function (this: Element) {
      const attribute = this.getAttribute?.(CHAT_BLOCK_INDEX_ATTRIBUTE);
      const scroller = layoutScroller;
      if (attribute === null || attribute === undefined || !scroller) {
        return originalGetBoundingClientRect.call(this);
      }
      const blocks = [...scroller.querySelectorAll(`[${CHAT_BLOCK_INDEX_ATTRIBUTE}]`)];
      const top = blocks.indexOf(this) * BLOCK_HEIGHT - scroller.scrollTop;
      return { top, bottom: top + BLOCK_HEIGHT, height: BLOCK_HEIGHT } as unknown as DOMRect;
    };
  });

  afterEach(() => {
    act(() => root.unmount());
    window.document.body.replaceChildren();
    window.Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    layoutScroller = null;
  });

  // 超长上下文下 DOM 只保留窗口内约 100 条：首条是完整消息，窗口前一条完全不进 DOM。
  test("超长时间线只渲染窗口内的约 100 条", async () => {
    await act(async () => root.render(<ChatView entries={prompts(300)} />));

    const ids = renderedEntryIds(host);
    expect(ids).toHaveLength(CHAT_WINDOW_ENTRY_BUDGET);
    // 尾部锚定：渲染的是最后 100 条（连续切片），窗口外的条目一条都没有。
    expect(ids).toEqual(Array.from({ length: CHAT_WINDOW_ENTRY_BUDGET }, (_, index) => `u-${index + 200}`));
    expect(host.textContent).toContain("第 200 条输入");
    expect(host.textContent).not.toContain("第 199 条输入");
  });

  // 滚动到顶部滑入更早条目：远端（最新一侧）滑出，窗口体量不变；scrollTop 按锚点补偿回原位。
  test("滚动到顶部滑入更早条目、远端滑出并补偿滚动位置", async () => {
    await act(async () => root.render(<ChatView entries={prompts(300)} />));
    const scroller = scrollerOf(host);
    installSyntheticLayout(scroller);

    await scrollTo(scroller, 0);

    const ids = renderedEntryIds(host);
    expect(ids[0]).toBe("u-188");
    expect(ids.at(-1)).toBe("u-287");
    expect(ids).toHaveLength(CHAT_WINDOW_ENTRY_BUDGET);
    expect(host.textContent).toContain("第 188 条输入");
    // 旧窗口首块（u-200）从第 0 块变成第 12 块 → 下移 1200px，scrollTop 必须等量补回。
    expect(scroller.scrollTop).toBe(12 * BLOCK_HEIGHT);
  });

  // 有进行中的响应时窗口尾部恒锚定最新块：向上浏览也不会把流式条目挤出渲染集合。
  test("进行中的响应期间最新条目始终留在窗口内", async () => {
    await act(async () => root.render(<ChatView entries={prompts(300)} isLoading />));
    const scroller = scrollerOf(host);
    installSyntheticLayout(scroller);

    await scrollTo(scroller, 0);

    const ids = renderedEntryIds(host);
    expect(ids[0]).toBe("u-188");
    expect(ids.at(-1)).toBe("u-299");
  });

  // 浏览历史期间新条目到达：窗口起点不动（顶部不静默裁剪），尾部跟上最新 —— 可见区域不跳。
  test("浏览历史期间新条目到达不挪动窗口起点", async () => {
    await act(async () => root.render(<ChatView entries={prompts(300)} isLoading />));
    const scroller = scrollerOf(host);
    installSyntheticLayout(scroller);

    await scrollTo(scroller, 0);
    const scrollTopAfterPrepend = scroller.scrollTop;
    expect(renderedEntryIds(host)[0]).toBe("u-188");

    await act(async () => root.render(<ChatView entries={prompts(320)} isLoading />));

    const ids = renderedEntryIds(host);
    expect(ids[0]).toBe("u-188");
    expect(ids.at(-1)).toBe("u-319");
    expect(scroller.scrollTop).toBe(scrollTopAfterPrepend);
  });

  // 窗口外条目的更新不丢也不重：滑进来时呈现最新内容，且同一条只出现一次。
  test("窗口外条目更新后滑入呈现最新内容且不重复", async () => {
    await act(async () => root.render(<ChatView entries={prompts(300)} />));
    const scroller = scrollerOf(host);
    installSyntheticLayout(scroller);

    await act(async () =>
      root.render(<ChatView entries={prompts(300, (index) => (index === 3 ? "第 3 条输入（已更新）" : undefined))} />),
    );
    expect(renderedEntryIds(host)).not.toContain("u-3");
    expect(host.textContent).not.toContain("已更新");

    // 提示词导航轨的刻度点击是「把窗口外条目滑回来」的真实入口。
    const tick = host.querySelectorAll<HTMLButtonElement>('[data-slot="preview-rail-item"]')[0];
    if (!tick) throw new Error("prompt rail tick not found");
    await act(async () => tick.click());

    const ids = renderedEntryIds(host);
    expect(ids).toContain("u-3");
    expect(ids.filter((id) => id === "u-3")).toHaveLength(1);
    expect(host.textContent).toContain("第 3 条输入（已更新）");
    expect(ids).toHaveLength(CHAT_WINDOW_ENTRY_BUDGET);
  });

  // 压测式长会话（尾部连续数千次工具调用会并成一个巨块）在首屏就必须受窗口约束。
  // 修复前：一块覆盖 3971 条，首屏 3971 个工具行 / 55648 个 DOM 节点（等于全量渲染）。
  test("尾部巨型工具链不会击穿首屏窗口", async () => {
    const entries = stressSession();
    const started = performance.now();
    await act(async () => root.render(<ChatView entries={entries} />));
    const elapsed = performance.now() - started;

    const rows = host.querySelectorAll('[data-slot="chat-tool-call-row"]').length;
    const messageEntries = renderedEntryIds(host).length;
    expect(rows).toBeGreaterThan(0);
    expect(rows + messageEntries).toBeLessThanOrEqual(CHAT_WINDOW_ENTRY_BUDGET);
    // 窗口锚在尾部：尾部整段都是工具行，因此一条消息条目都不该出现（出现即说明窗口没锚在尾部）。
    expect(messageEntries).toBe(0);
    // DOM 规模量级守卫（修复前同输入为 55648 个节点）。
    expect(host.querySelectorAll("*").length).toBeLessThanOrEqual(2000);
    expect(elapsed).toBeLessThan(5000);
  });

  // 加载/回放期间（`isLoading`）走的是同一条窗口路径：不能因为 loading 就退化成全量渲染。
  test("加载期间同样只渲染窗口内的条目", async () => {
    const entries = stressSession();
    await act(async () => root.render(<ChatView entries={entries} isLoading />));

    const rows = host.querySelectorAll('[data-slot="chat-tool-call-row"]').length;
    const messageEntries = renderedEntryIds(host).length;
    expect(rows + messageEntries).toBeLessThanOrEqual(CHAT_WINDOW_ENTRY_BUDGET);
    expect(messageEntries).toBe(0);
    expect(host.querySelectorAll("*").length).toBeLessThanOrEqual(2000);
  });

  // 回到底部恢复最新窗口：浏览历史后滚到底，窗口重新锚定到最后一批条目。
  test("回到底部恢复最新窗口", async () => {
    await act(async () => root.render(<ChatView entries={prompts(300)} />));
    const scroller = scrollerOf(host);
    installSyntheticLayout(scroller);

    await scrollTo(scroller, 0);
    expect(renderedEntryIds(host)[0]).toBe("u-188");

    await scrollTo(scroller, () => scroller.scrollHeight - VIEWPORT_HEIGHT);

    const ids = renderedEntryIds(host);
    expect(ids[0]).toBe("u-200");
    expect(ids.at(-1)).toBe("u-299");
  });
});
