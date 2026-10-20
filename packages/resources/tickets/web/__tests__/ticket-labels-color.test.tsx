// web/__tests__/ticket-labels-color.test.tsx
// 标签颜色的形态对账：后端（Forgejo → `TicketLabelViewSchema`）给的是**裸十六进制**（服务端已把 `#` 归一去掉），
// 前端旧口径「必须带 `#`」会让圆点永不渲染——这里用真实组件锁死两条边界：裸值可渲染（渲染时补 `#`）、
// 带 `#` 的旧形态仍容忍、非法值与 `null` 一律忽略。`open=false` 只渲染 chips，不碰 `Checkbox` 覆盖层。

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { UI_COMPONENTS_NS, uiComponentsResources } from "@fenix/ui-components/i18n";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";

import type { TicketLabel } from "../api/tickets";
import type { TicketLabelsState } from "../hooks/use-ticket-labels";
import { TICKETS_NS, ticketsResources } from "../i18n";
import { TicketLabelsEditor } from "../pages/agent-panel/components/ticket-labels-editor";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const win = initializeHappyDomWindow(new Window({ url: "https://localhost:3000" }));
const globals = globalThis as Record<string, unknown>;

/** DOM 全局构造器：同进程跑完全部包时其它文件会读写它们，故每例重放（与写动作用例同款）。 */
const DOM_GLOBALS = [
  "CustomEvent",
  "DOMRect",
  "DocumentFragment",
  "Element",
  "Event",
  "EventTarget",
  "FocusEvent",
  "HTMLElement",
  "HTMLAnchorElement",
  "HTMLButtonElement",
  "HTMLInputElement",
  "KeyboardEvent",
  "MouseEvent",
  "MutationObserver",
  "Node",
  "NodeFilter",
  "ResizeObserver",
  "customElements",
] as const;

const originalGlobals = new Map<string, unknown>([
  ...["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"].map((key) => [key, globals[key]] as const),
  ...DOM_GLOBALS.map((key) => [key, globals[key]] as const),
  ["requestAnimationFrame", globals.requestAnimationFrame],
  ["cancelAnimationFrame", globals.cancelAnimationFrame],
  ["getComputedStyle", globals.getComputedStyle],
]);

function applyDomGlobals(): void {
  globals.window = win;
  globals.document = win.document;
  globals.navigator = win.navigator;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  for (const key of DOM_GLOBALS) {
    globals[key] = (win as unknown as Record<string, unknown>)[key];
  }
  globals.requestAnimationFrame = win.requestAnimationFrame.bind(win);
  globals.cancelAnimationFrame = win.cancelAnimationFrame.bind(win);
  globals.getComputedStyle = win.getComputedStyle.bind(win);
}

applyDomGlobals();

const originalConsoleError = console.error;

const i18n = createInstance();
await i18n.init({
  lng: "zh",
  fallbackLng: "zh",
  defaultNS: TICKETS_NS,
  initAsync: false,
  resources: {
    zh: { [TICKETS_NS]: ticketsResources.zh, [UI_COMPONENTS_NS]: uiComponentsResources.zh },
  },
});

/** chips 只读快照 + 不展开编辑区：颜色只看 chips 的圆点，避免引入 Checkbox 等交互件。 */
function labelsState(): TicketLabelsState {
  return {
    catalog: [],
    catalogLoading: false,
    catalogError: undefined,
    retryCatalog: () => {},
    draftIds: [],
    toggle: () => {},
    dirty: false,
    saving: false,
    save: async () => ({ kind: "succeeded" }),
  };
}

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  applyDomGlobals();
  console.error = () => {};
  container = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(container as unknown as Parameters<typeof win.document.body.appendChild>[0]);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container.remove();
  console.error = originalConsoleError;
});

afterAll(() => {
  for (const [key, value] of originalGlobals) {
    if (value === undefined) delete globals[key];
    else globals[key] = value;
  }
});

function renderChips(current: TicketLabel[]): void {
  act(() => {
    root = createRoot(container);
  });
  act(() => {
    root.render(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(TicketLabelsEditor, {
          current,
          disabled: false,
          labels: labelsState(),
          onOpenChange: () => {},
          open: false,
        }),
      ),
    );
  });
}

/** 圆点是 chips 里唯一的 `aria-hidden` 空文本元素；占位形态没有 `aria-hidden`，可直接区分渲染与否。 */
function dots(): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('span[aria-hidden="true"]'));
}

describe("标签颜色形态（组件级）", () => {
  // 后端视图的裸十六进制必须渲染成圆点，且内联色补回 `#`（缺前缀的 backgroundColor 在 CSS 里无效）。
  test("裸十六进制渲染圆点并补 # 前缀", () => {
    renderChips([{ id: "1", name: "缺陷", color: "ff0000" }]);
    const rendered = dots();
    expect(rendered).toHaveLength(1);
    expect(rendered[0]?.className).toContain("rounded-full");
    const inline = rendered[0]?.getAttribute("style") ?? "";
    expect(inline).toMatch(/background-color:\s*(#ff0000|rgb\(255,\s*0,\s*0\))/i);
  });

  // 带 `#` 的旧口径形态仍容忍（前端合同 §6.2 的写法），避免历史数据或手工输入造成静默丢失。
  test("带 # 的形态同样渲染", () => {
    renderChips([{ id: "1", name: "缺陷", color: "#00ff00" }]);
    expect(dots()).toHaveLength(1);
  });

  // 颜色是上游自由字段：`null` 与非法值（色名、长度不足、非十六进制字符）只占位不渲染，
  // 界面不出现含义不明的色点（也不回退成灰点）。
  test("null 与非法值不渲染圆点", () => {
    renderChips([
      { id: "1", name: "无颜色", color: null },
      { id: "2", name: "色名", color: "red" },
      { id: "3", name: "太短", color: "12" },
      { id: "4", name: "非十六进制", color: "gggggg" },
    ]);
    expect(dots()).toHaveLength(0);
  });
});
