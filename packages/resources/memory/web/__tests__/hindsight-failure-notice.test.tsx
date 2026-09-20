// web/__tests__/hindsight-failure-notice.test.tsx
// 钉住失败块的关键交互契约：无权限分支不渲染重试按钮（对 403 重试永远无效），通用失败分支的
// 重试按钮必须真的接到调用方的回调上。断言只碰交互与按钮存在性，不碰文案——文案取值取决于
// 同进程 i18n 单例状态（见 §1.6 的文案断言说明），断言文案会引入环境相关的假绿/假红。

import { afterEach, describe, expect, test } from "bun:test";
import { ApiError } from "@fenix/web-runtime/api/request";
import { Window } from "happy-dom";
import i18next from "i18next";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { HINDSIGHT_NS, hindsightResources } from "../i18n";
import { HindsightFailureNotice } from "../pages/hindsight/components/HindsightFailureNotice";
import { toHindsightFailure } from "../pages/hindsight/failure";
import { initializeHappyDomWindow } from "./happy-dom-window";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const win = initializeHappyDomWindow(new Window());
(globalThis as Record<string, unknown>).window = win;
(globalThis as Record<string, unknown>).document = win.document;

/**
 * 用本包真实字典初始化一个**独立** i18n 实例经 Provider 传入。
 *
 * 不注册 `initReactI18next`（那会把实例挂成全局单例，残留到同进程的其他测试文件），
 * 也不用宿主单例：本包测试必须在没有 apps/web 的前提下自足。
 */
const i18n = i18next.createInstance();
await i18n.init({
  lng: "en",
  ns: HINDSIGHT_NS,
  defaultNS: HINDSIGHT_NS,
  resources: { en: { [HINDSIGHT_NS]: hindsightResources.en } },
});

let root: Root | null = null;

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
});

/** 渲染一次失败块（带上字典 Provider），返回可查询的容器。 */
function renderNotice(element: ReturnType<typeof createElement>) {
  const container = win.document.createElement("div") as unknown as HTMLElement;
  root = createRoot(container);
  act(() => root?.render(createElement(I18nextProvider, { i18n }, element)));
  return container;
}

describe("HindsightFailureNotice", () => {
  // 无权限（403）不给重试入口：按钮点了只会得到同一个 403，界面不该提供死循环操作。
  test("无权限分支不渲染重试按钮", () => {
    let retries = 0;
    const container = renderNotice(
      createElement(HindsightFailureNotice, {
        failure: toHindsightFailure(new ApiError("Cannot resolve bank ID", "forbidden")),
        titleKey: "dataView.loadFailed",
        retryKey: "dataView.retry",
        onRetry: () => {
          retries += 1;
        },
      }),
    );

    expect(container.querySelectorAll("button").length).toBe(0);
    expect(retries).toBe(0);
  });

  // 通用失败重试按钮必须接到调用方回调（否则界面看起来能重试、实际什么也不做）。
  test("通用失败分支的重试按钮触发回调", () => {
    let retries = 0;
    const container = renderNotice(
      createElement(HindsightFailureNotice, {
        failure: toHindsightFailure(new ApiError("Hindsight service unavailable", "service_unavailable")),
        titleKey: "dataView.loadFailed",
        retryKey: "dataView.retry",
        onRetry: () => {
          retries += 1;
        },
      }),
    );

    const buttons = container.querySelectorAll("button");
    expect(buttons.length).toBe(1);
    act(() => (buttons[0] as HTMLButtonElement).click());
    expect(retries).toBe(1);
  });

  // 未接入重试的调用点（如记忆详情弹窗只展示失败原因）不得凭空出现按钮。
  test("未提供重试回调时不渲染按钮", () => {
    const container = renderNotice(
      createElement(HindsightFailureNotice, {
        failure: toHindsightFailure(new ApiError("boom", "SERVER_ERROR")),
      }),
    );

    expect(container.querySelectorAll("button").length).toBe(0);
  });
});
