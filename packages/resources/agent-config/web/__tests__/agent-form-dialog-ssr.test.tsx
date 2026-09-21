// web/__tests__/agent-form-dialog-ssr.test.tsx
// 从宿主 `apps/web/src/__tests__/` 迁入（CE 阶段 2 任务 1.6 T12）。
//
// 判定口径与 T10b1~T10b4 的 8 份同源用例一致：被测实现 `AgentFormDialog` 归本包
// `web/pages/agent-panel/agent-editor/`，留在宿主只能以四级相对路径反向读取包内实现，等于让包内
// 实现被应用壳测试守护（本文件此前正是那种写法）。
//
// 与源实现的唯一差异是 i18n：原文件取宿主启动期单例 `@/src/i18n`，迁入后改用自建的空字典实例。
// 三条断言全部是「服务端渲染输出为空」，不涉及任何文案，空字典足够；这也免去本包测试对宿主 i18n
// 注册顺序的依赖（同款先例：`knowledge/web/__tests__/knowledge-access-denied.test.tsx`）。

import { describe, expect, test } from "bun:test";
import { createInstance } from "i18next";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";

import { AgentFormDialog } from "../pages/agent-panel/agent-editor/AgentFormDialog";

/** 空字典实例：`t()` 回显 key，而本文件断言的是「什么都不渲染」，回显与否都不影响结果。 */
const i18n = createInstance();
void i18n.init({ lng: "zh", fallbackLng: "zh", initAsync: false, resources: {} });

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
