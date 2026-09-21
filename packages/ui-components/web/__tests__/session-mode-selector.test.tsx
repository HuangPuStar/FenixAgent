// SessionModeSelector 的服务端渲染测试（CE 阶段 2 §1.6 T6c1 从
// `packages/agent-runtime/web/__tests__/session-mode-selector.test.tsx` 迁入包内）。
//
// 迁移改动：组件改从包内 `../chat/composer/SessionModeSelector` 导入；i18n 从宿主单例换成包内
// `createInstance` + `../i18n/locales/en/uiComponents.json`（命名空间 `UI_COMPONENTS_NS`，回落键
// `chat.components.sessionModeSelector.default`）。SSR 不需要 DOM 引导，故不引入 happy-dom。
//
// 断言仍以 prop 传入的模式名为准（组件优先展示 `modes` 里的名称，只有缺名称时才回落到字典），
// 因此语义与旧用例一致。

import { describe, expect, test } from "bun:test";
import { createInstance } from "i18next";
import ReactDOMServer from "react-dom/server";
import { initReactI18next } from "react-i18next/initReactI18next";
import { SessionModeSelector } from "../chat/composer/SessionModeSelector";
import en from "../i18n/locales/en/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";

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

describe("SessionModeSelector", () => {
  // 渲染当前模式名称
  test("renders current mode name", () => {
    const html = ReactDOMServer.renderToString(
      <SessionModeSelector
        modes={[{ id: "default", name: "默认模式" }]}
        currentModeId="default"
        onModeChange={() => {}}
      />,
    );
    expect(html).toContain("默认模式");
  });

  // modes 为空时渲染为空
  test("renders nothing when modes is empty", () => {
    const html = ReactDOMServer.renderToString(
      <SessionModeSelector modes={[]} currentModeId={null} onModeChange={() => {}} />,
    );
    expect(html).toBe("");
  });
});
