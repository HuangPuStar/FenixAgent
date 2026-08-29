import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";

import i18n from "../i18n";
import { AgentFormDialog } from "../pages/agent-panel/agent-editor/AgentFormDialog";

function renderDialog(props: Parameters<typeof AgentFormDialog>[0]) {
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(AgentFormDialog, props)));
}

describe("AgentFormDialog SSR 初始展示", () => {
  // 关闭状态不应输出遮罩或表单，避免未打开的对话框占用页面结构。
  test("关闭时不渲染对话框内容", () => {
    expect(renderDialog({ open: false, mode: "create", onOpenChange: () => {} })).toBe("");
  });

  // 创建模式使用 Radix Portal，服务端渲染不得输出不完整的对话框结构。
  test("创建模式服务端渲染保持为空", () => {
    expect(renderDialog({ open: true, mode: "create", onOpenChange: () => {} })).toBe("");
  });

  // 编辑模式同样通过 Sheet Portal 在客户端挂载，SSR 不应访问浏览器 API 或输出悬浮面板。
  test("编辑模式服务端渲染保持为空", () => {
    expect(renderDialog({ open: true, mode: "edit", agentName: "agent-a", onOpenChange: () => {} })).toBe("");
  });
});
