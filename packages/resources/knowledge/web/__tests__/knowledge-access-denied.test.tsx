// web/__tests__/knowledge-access-denied.test.tsx
// 守护知识库页面的「无权限」状态（§1.3(6) 的前端状态口径）。
//
// 两件事必须被钉住，否则会静默回退成「可重试的普通错误」：
//   1. 判定口径——401/403 在 request 层已归一为 `UNAUTHORIZED`，前端只能按错误码识别；
//      跨模块实例的 `ApiError`（instanceof 失效）也必须照样识别，否则无权限会被渲染成可重试错误。
//   2. 渲染口径——状态带 `role="alert"`，且**不得**出现按钮：重试一个没有授权的请求不会改变结果。
//
// 只做 SSR 断言（`react-dom/server`）而不是 DOM 交互：本状态没有任何交互，唯一的行为契约就是
// 「无按钮 + 可被屏幕阅读器播报」。用空字典让 `t(key)` 原样回显 key，文案改动不会让断言失真
// （同款先例：本包 web/src/__tests__/context-panel-ssr.test.tsx）。

import { describe, expect, test } from "bun:test";
import { ApiError } from "@fenix/web-runtime/api/request";
import { createInstance } from "i18next";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import {
  AgentKnowledgeAccessDenied,
  isKnowledgeAccessDenied,
} from "../pages/agent-panel/pages/agent-knowledge-access-denied";

const i18n = createInstance();
void i18n.init({ lng: "zh", fallbackLng: "zh", initAsync: false, resources: {} });

describe("知识库无权限状态", () => {
  // request 层把 401/403 归一为 UNAUTHORIZED，页面按该码决定是否整页接管。
  test("UNAUTHORIZED 判定为无权限，其余错误码判定为普通错误", () => {
    expect(isKnowledgeAccessDenied(new ApiError("无权限", "UNAUTHORIZED"))).toBe(true);
    expect(isKnowledgeAccessDenied(new ApiError("服务器错误", "SERVER_ERROR"))).toBe(false);
    expect(isKnowledgeAccessDenied(new ApiError("未找到", "NOT_FOUND"))).toBe(false);
  });

  // 宿主若经别名重复打包 web-runtime，ApiError 会跨模块实例、instanceof 失效；
  // 此时仍须按 code 字段识别，否则无权限会退化成带重试按钮的普通错误。
  test("跨模块实例的同码错误按 code 字段兜底识别", () => {
    expect(isKnowledgeAccessDenied({ code: "UNAUTHORIZED", message: "401" })).toBe(true);
    expect(isKnowledgeAccessDenied({ code: "SERVER_ERROR" })).toBe(false);
  });

  // 非结构化错误（网络层普通 Error、undefined、字符串）不得误判成无权限。
  test("无法读出错误码的取值一律不判定为无权限", () => {
    expect(isKnowledgeAccessDenied(new Error("network"))).toBe(false);
    expect(isKnowledgeAccessDenied(undefined)).toBe(false);
    expect(isKnowledgeAccessDenied(null)).toBe(false);
    expect(isKnowledgeAccessDenied("UNAUTHORIZED")).toBe(false);
    expect(isKnowledgeAccessDenied({ code: 401 })).toBe(false);
  });

  // 状态必须可被屏幕阅读器播报（role="alert"），且不提供重试入口。
  test("渲染出 alert 状态说明且不含任何按钮", () => {
    const html = renderToStaticMarkup(
      createElement(I18nextProvider, { i18n }, createElement(AgentKnowledgeAccessDenied)),
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("accessDenied.title");
    expect(html).toContain("accessDenied.description");
    expect(html).not.toContain("<button");
  });
});
