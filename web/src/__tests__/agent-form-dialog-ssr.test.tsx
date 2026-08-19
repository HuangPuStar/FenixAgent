import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";

import i18n from "../i18n";
import { AgentFormDialog } from "../pages/agent-panel/AgentFormDialog";

function renderDialog(props: Parameters<typeof AgentFormDialog>[0]) {
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(AgentFormDialog, props)));
}

describe("AgentFormDialog SSR 初始展示", () => {
  // 关闭状态不应输出遮罩或表单，避免未打开的对话框占用页面结构。
  test("关闭时不渲染对话框内容", () => {
    expect(renderDialog({ open: false, mode: "create", onOpenChange: () => {} })).toBe("");
  });

  // 创建 Agent 时应呈现基础配置入口、表单字段与创建动作，供用户完成首次配置。
  test("创建模式渲染基础配置表单", () => {
    const html = renderDialog({ open: true, mode: "create", onOpenChange: () => {} });

    expect(html).toContain("dialog.createTitle");
    expect(html).toContain("dialog.tabs.basic");
    expect(html).toContain("dialog.tabs.knowledge");
    expect(html).toContain("dialog.tabs.advanced");
    expect(html).toContain("form.name");
    expect(html).toContain("form.model");
    expect(html).toContain("form.prompt");
    expect(html).toContain("dialog.create");
  });

  // 编辑模式在尚未加载资源详情时仍应展示编辑框架与保存动作，而不依赖浏览器 API。
  test("编辑模式渲染编辑框架", () => {
    const html = renderDialog({ open: true, mode: "edit", onOpenChange: () => {} });

    expect(html).toContain("dialog.editTitle");
    expect(html).toContain("form.name");
    expect(html).toContain("dialog.cancel");
    expect(html).toContain('data-slot="input"');
    expect(html).toContain('disabled=""');
  });
});
