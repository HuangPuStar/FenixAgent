import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PublicErrorCard } from "../chat/view/PublicErrorCard";
import en from "../i18n/locales/en/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";

const window = initializeHappyDomWindow(new Window());
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  customElements: window.customElements,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const i18n = createInstance();
void i18n.init({
  lng: "en",
  initAsync: false,
  resources: { en: { [UI_COMPONENTS_NS]: en } },
});
const t = i18n.getFixedT("en", UI_COMPONENTS_NS);
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  jest.useFakeTimers();
  host = window.document.createElement("div") as unknown as HTMLDivElement;
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  jest.useRealTimers();
});

/** 渲染真实错误卡片；只替换错误身份，模拟后续收到另一条错误。 */
function renderError(id: string, dismissible = true) {
  act(() => {
    root.render(
      <PublicErrorCard
        error={{ id, type: "ACTION.OUTCOME_UNKNOWN", message: "Outcome unknown" }}
        t={t}
        dismissible={dismissible}
      />,
    );
  });
}

// 用户关闭只隐藏当前提示，新错误仍应重新显示。
test("closing a notice hides it until a different error arrives", () => {
  renderError("err-first");
  const button = host.querySelector<HTMLButtonElement>('button[aria-label="Dismiss error"]');
  expect(button).not.toBeNull();
  act(() => button?.click());
  expect(host.querySelector('[role="alert"]')).toBeNull();
  renderError("err-first");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  renderError("err-next");
  expect(host.textContent).toContain("err-next");
});

// 每条新错误有完整五秒展示时间，旧错误的计时器不能提前关闭新提示。
test("new errors restart the five-second dismissal deadline", () => {
  renderError("err-first");
  act(() => jest.advanceTimersByTime(4_000));
  expect(host.textContent).toContain("err-first");
  renderError("err-next");
  act(() => jest.advanceTimersByTime(1_000));
  expect(host.textContent).toContain("err-next");
  act(() => jest.advanceTimersByTime(3_999));
  expect(host.textContent).toContain("err-next");
  act(() => jest.advanceTimersByTime(1));
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

// 历史消息和终态错误默认保留，不能因顶部提示的自动消失规则而丢失展示。
test("persistent error cards remain visible without dismissal controls", () => {
  renderError("err-history", false);
  act(() => jest.advanceTimersByTime(20_000));
  expect(host.textContent).toContain("err-history");
  expect(host.querySelector("button")).toBeNull();
});
