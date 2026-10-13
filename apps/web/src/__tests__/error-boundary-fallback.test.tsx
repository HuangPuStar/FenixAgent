// web/src/__tests__/error-boundary-fallback.test.tsx
// 宿主错误边界的接线契约（前端规范 §7.1 放置矩阵 / §7.2 降级策略）。
//
// §7.1 的五个落点（`__root.tsx` / `agent/_panel.tsx` / `ChatPanel` / `ArtifactsPanel` / `AgentSidebar`）
// 用的是同一条链路：`react-error-boundary` 的 `ErrorBoundary` + 组件库的统一 `ErrorFallback`。本文件钉住
// 这条链路上两个「只有真跑起来才知道」的不变量：
//   1. 子组件抛错 → 渲染降级 UI，且**不出现** `error.message`（原始错误只进 `onError`）；
//   2. 点重试 → 边界重置、子树真的重新渲染（§7.2 的重试出口不是摆设）。
//
// 不逐个渲染那五处面板：它们各自依赖会话 / 组织 / WS 运行时，为一条通用接线去 mock 一整套 Provider
// 只会让用例跟着面板实现漂移；边界行为属于「接线」，按接线断言。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { uiComponentsResources } from "@fenix/ui-components/i18n";
import { UI_COMPONENTS_NS } from "@fenix/ui-components/i18n/namespace";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { ErrorFallback } from "@fenix/ui-components/ui/error-fallback";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ErrorBoundary } from "react-error-boundary";
import { I18nextProvider } from "react-i18next";
import { initReactI18next } from "react-i18next/initReactI18next";

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
  resources: { en: { [UI_COMPONENTS_NS]: uiComponentsResources.en } },
});

const EXPECTED_FALLBACK_TEXT = uiComponentsResources.en.errors.renderFailed;

/** 降级 UI 绝不该露出这串字：它模拟后端 / 解析器写进 `error.message` 的内部细节。 */
const INTERNAL_MESSAGE = "内部实现细节：解析器在 at Foo.bar 处栈溢出";

/** 首帧抛错、重置后能正常渲染的面板替身：用来区分「崩溃态」与「重试后的恢复态」。 */
let shouldThrow = true;

function FlakyPanel() {
  if (shouldThrow) throw new Error(INTERNAL_MESSAGE);
  return <p>面板已恢复</p>;
}

describe("错误边界降级链路", () => {
  let host: HTMLDivElement;
  let root: Root;
  let originalConsoleError: typeof console.error;

  beforeEach(() => {
    shouldThrow = true;
    // React 19 会把被边界接住的错误原样打到 console.error，这里静音以免刷屏；
    // 用例自身关心的「原始错误是否传到 onError」由注入的回调断言，与 console 无关。
    originalConsoleError = console.error;
    console.error = () => {};
    host = window.document.createElement("div") as unknown as HTMLDivElement;
    window.document.body.appendChild(host as unknown as Parameters<typeof window.document.body.appendChild>[0]);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    window.document.body.replaceChildren();
    console.error = originalConsoleError;
  });

  /** 按五处落点一致的接线渲染边界，返回重试按钮与收到的原始错误。 */
  async function renderBoundary(): Promise<{ button: HTMLButtonElement; errors: unknown[] }> {
    const errors: unknown[] = [];
    await act(async () => {
      root.render(
        <I18nextProvider i18n={i18n}>
          <ErrorBoundary
            FallbackComponent={ErrorFallback}
            onError={(error) => {
              errors.push(error);
            }}
          >
            <FlakyPanel />
          </ErrorBoundary>
        </I18nextProvider>,
      );
    });
    const button = host.querySelector<HTMLButtonElement>("button");
    if (!button) throw new Error("降级 UI 里没有重试按钮");
    return { button, errors };
  }

  // 业务意图：面板崩溃时用户只应看到固定文案与重试出口（§7.2）——`error.message` 可能含后端或第三方
  // 解析器的内部细节，一旦渲染出去就成了「崩溃时顺手泄密」，且它不随语言变化。
  test("子组件抛错：渲染降级 UI，原始错误只进 onError 不进界面", async () => {
    const { errors } = await renderBoundary();

    expect(host.textContent).toContain(EXPECTED_FALLBACK_TEXT);
    expect(host.textContent).not.toContain(INTERNAL_MESSAGE);
    // `onError` 收到的是原始抛错对象（`unknown`）：诊断上下文在 console 这一侧，不在界面上。
    expect(errors.map((error) => (error instanceof Error ? error.message : String(error)))).toEqual([INTERNAL_MESSAGE]);
  });

  // 业务意图：重试必须真的把子树重新挂载回去（§7.2 的重试按钮），否则用户唯一的出路是刷新整页——
  // 而刷新会丢掉未保存的会话状态。
  test("点重试：边界重置，子树重新渲染", async () => {
    const { button } = await renderBoundary();
    expect(host.textContent).not.toContain("面板已恢复");

    shouldThrow = false;
    await act(async () => button.click());

    expect(host.textContent).toContain("面板已恢复");
    expect(host.textContent).not.toContain(EXPECTED_FALLBACK_TEXT);
  });
});
