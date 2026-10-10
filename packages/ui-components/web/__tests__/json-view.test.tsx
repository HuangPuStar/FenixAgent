// web/__tests__/json-view.test.tsx
// `JsonViewer`（`ui/json-view`）的行为测试：折叠深度、条目上限、循环引用与深嵌套的兜底文本、
// 长字符串的截断与展开、空容器不留假箭头。
//
// 2026-10-10 随实现从 trace 面板下沉进本包，断言随迁并改为读包内字典（`jsonViewer.*`）的真实文案，
// 不做模块替身（CLAUDE.md 禁止测试文件直接调用 `mock.module()`，且替身会跨文件泄漏）。
// 折叠 / 展开是组件的核心交互，静态渲染证明不了按钮点得动，故走 happy-dom + createRoot；引导方式
// 与 `error-fallback.test.tsx` 一致（成对注入 HTMLElement / customElements）。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { initReactI18next } from "react-i18next/initReactI18next";
import en from "../i18n/locales/en/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";
import { JsonViewer } from "../ui/json-view";

const window = initializeHappyDomWindow(new Window());
const globalRecord = globalThis as Record<string, unknown>;
globalRecord.window = window;
globalRecord.document = window.document;
globalRecord.navigator = window.navigator;
// `HTMLElement` 与 `customElements` 成对注入，避免只注入前者让后续文件的 web-components 判定崩在空档里。
globalRecord.HTMLElement = window.HTMLElement;
globalRecord.customElements = window.customElements;
globalRecord.IS_REACT_ACT_ENVIRONMENT = true;

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

const LABELS = en.jsonViewer;

describe("JsonViewer", () => {
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

  /** 渲染一次并返回读取器：文本与按钮每次都从当前 DOM 取，展开操作后的断言才看得到新状态。 */
  function mount(data: unknown, collapsed?: number) {
    act(() => {
      root.render(
        <I18nextProvider i18n={i18n}>
          <JsonViewer data={data} collapsed={collapsed} />
        </I18nextProvider>,
      );
    });
    return {
      text: () => host.textContent ?? "",
      buttons: () => [...host.querySelectorAll("button")],
    };
  }

  // 空值是「没有数据」，与 JSON 里的 null 字面量不是一回事：前者给占位文案，后者照常渲染 null。
  test("空值渲染 empty 文案，null 字面量照常渲染", () => {
    expect(mount(null).text()).toContain(LABELS.empty);
    expect(mount(undefined).text()).toContain(LABELS.empty);
    expect(mount({ value: null }).text()).toContain("null");
  });

  // 默认只展开前两层：深层结构不铺满面板，逐级点开才看得到。
  test("默认折叠深度为 2，展开后可见第三层", () => {
    const { text, buttons } = mount({ level1: { level2: { level3: "deep" } } });
    expect(text()).toContain("level2");
    expect(text()).not.toContain("level3");

    // DOM 顺序上最深的容器按钮在最后：容器先渲染自己的计数按钮，再渲染子节点。
    const deepest = buttons().at(-1);
    act(() => deepest?.click());
    expect(text()).toContain("level3");
    expect(text()).toContain("deep");
  });

  // 单容器最多渲染 200 条，其余只报计数：巨量数组不能把面板拖死，但规模要看得见。
  test("数组超过 200 条时折叠为计数行", () => {
    const { text } = mount(Array.from({ length: 205 }, (_, index) => index));
    expect(text()).toContain(LABELS.moreEntries.replace("{{count}}", "5"));
  });

  // 循环引用按路径判定：给出固定文本，既不抛错也不无限递归。
  test("循环引用显示 circular 文案", () => {
    const node: Record<string, unknown> = { name: "root" };
    node.self = node;
    expect(mount(node).text()).toContain(LABELS.circular);
  });

  // 病态深嵌套有兜底文本：外部数据不可信，渲染栈不能被打穿（用例显式给大折叠深度，否则到不了深度上限）。
  test("超过深度上限显示 tooDeep 文案", () => {
    let deep: unknown = "leaf";
    for (let index = 0; index < 40; index++) deep = { nested: deep };
    expect(mount(deep, Number.POSITIVE_INFINITY).text()).toContain(LABELS.tooDeep);
  });

  // 空容器直接渲染 {} / []，不留可点的假箭头（按钮数 = 只有根容器一个）。
  test("空对象与空数组直接显示 {} / []", () => {
    const { text, buttons } = mount({ empty: {}, list: [] });
    expect(text()).toContain("{}");
    expect(text()).toContain("[]");
    expect(buttons()).toHaveLength(1);
  });

  // 长字符串先截断，点「展开全文」才铺开：观测载荷里的大段文本不该默认占满面板。
  test("长字符串截断后可展开全文", () => {
    const long = "x".repeat(400);
    const { text, buttons } = mount({ payload: long });
    expect(text()).not.toContain(long);

    const toggle = buttons().find((button) => button.textContent === LABELS.showMore);
    expect(toggle).toBeDefined();
    act(() => toggle?.click());
    expect(text()).toContain(long);
    expect(buttons().some((button) => button.textContent === LABELS.showLess)).toBe(true);
  });
});
