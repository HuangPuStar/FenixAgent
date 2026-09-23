// web/__tests__/error-fallback.test.tsx
// `ErrorFallback`（`ui/error-fallback`）的契约测试：文案取包内字典、重试按钮把控制权交回
// `resetErrorBoundary`、容器形态由 `variant` 决定（前端规范 §7.1 放置矩阵 / §7.2 降级策略）。
//
// 「边界接住子组件抛错」的集成链路不在这里：本包刻意不依赖 `react-error-boundary`（理由见组件文件头），
// 那条链路由宿主 `apps/web/src/__tests__/error-boundary-fallback.test.tsx` 用真实 `ErrorBoundary` 钉住。
//
// 渲染走 happy-dom：重试按钮必须真的能点（读屏文案与按钮语义都在标记里，但「点了会不会回调」只有
// 真实事件才行），骨架沿用本包既有交互用例（`message-bubble-copy.test.tsx`）。

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
import { ErrorFallback, type ErrorFallbackProps } from "../ui/error-fallback";

const window = initializeHappyDomWindow(new Window());
const globalRecord = globalThis as Record<string, unknown>;
globalRecord.window = window;
globalRecord.document = window.document;
globalRecord.navigator = window.navigator;
// `HTMLElement` 与 `customElements` 成对注入（§11.2）：只注入前者会让后续文件里 streamdown 的
// web-components 判定「有 DOM、没有注册表」而崩在用例之间的空档里。
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

const EXPECTED = en.errors;

describe("ErrorFallback 降级 UI", () => {
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

  /** 渲染降级 UI，返回其中的重试按钮。 */
  async function renderFallback(props: ErrorFallbackProps): Promise<HTMLButtonElement> {
    await act(async () => {
      root.render(
        <I18nextProvider i18n={i18n}>
          <ErrorFallback {...props} />
        </I18nextProvider>,
      );
    });
    const button = host.querySelector<HTMLButtonElement>("button");
    if (!button) throw new Error("降级 UI 里没有重试按钮");
    return button;
  }

  // 业务意图：降级 UI 是崩溃后用户唯一能看见的东西，文案必须来自包内字典（随语言切换）而不是 key 回显，
  // 并带读屏可播报的告警语义；「内容渲染失败」这行字消失，用户就只剩一块空白区域。
  test("文案取包内字典（不是 key 回显），并带 role=alert", async () => {
    await renderFallback({ resetErrorBoundary: () => {} });

    expect(host.textContent).toContain(EXPECTED.renderFailed);
    expect(host.textContent).toContain(EXPECTED.retry);
    expect(host.textContent).not.toContain("errors.renderFailed");
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
  });

  // 业务意图：§7.2 要求降级 UI 必须有重试出口。这里断言的正是那个出口真的接到了边界的重置回调——
  // 按钮长得对但点了没反应，等于把用户困在崩溃页上，只有重新加载整页才能恢复。
  test("点重试把控制权交回 resetErrorBoundary", async () => {
    let resets = 0;
    const button = await renderFallback({
      resetErrorBoundary: () => {
        resets += 1;
      },
    });

    await act(async () => button.click());

    expect(resets).toBe(1);
  });

  // 业务意图：各面板的措辞并不相同（预览器要说「预览组件加载失败」而不是通用的内容渲染失败），
  // 覆盖端口必须生效，否则要么被迫在各包复制一份降级 UI，要么让用户看到一句不贴切的提示。
  test("message 覆盖默认文案", async () => {
    await renderFallback({ resetErrorBoundary: () => {}, message: "预览组件加载失败" });

    expect(host.textContent).toContain("预览组件加载失败");
    expect(host.textContent).not.toContain(EXPECTED.renderFailed);
  });

  // 业务意图：面板崩了要撑满原来的位置（`panel`，同 §2.5 的 `Spinner` 口径），整屏崩了要占据视口
  // （`screen`）——容器形态若由各调用点手写，同一处降级在五种壳里会长得不一样。
  test("variant 决定容器形态：panel 撑满内容区，screen 占整屏", async () => {
    await renderFallback({ resetErrorBoundary: () => {} });
    const panelClass = host.querySelector('[role="alert"]')?.className ?? "";
    expect(panelClass).toContain("flex-1");

    await renderFallback({ resetErrorBoundary: () => {}, variant: "screen" });
    const screenClass = host.querySelector('[role="alert"]')?.className ?? "";
    expect(screenClass).toContain("h-screen");
    expect(screenClass).not.toContain("flex-1");
  });
});
