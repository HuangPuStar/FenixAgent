// ToolCallGroup 对记忆工具的分流回归（MEM-BUG-001）。
//
// 事故：ccb / peri / claude-code 的记忆检索经市场插件走 MCP，工具名是
// `mcp__hindsight__agent_knowledge_recall`。旧判定只认 opencode 插件的 `hindsight_` 前缀，
// 该调用便落进普通工具行，被 rawInput 的 `query → web-search` 兜底渲染成“搜索网页 <query>”，
// 用户误以为在检索公网。
//
// 本用例从渲染层守住分流契约：记忆工具进紫色卡片（含“搜索记忆”语义），普通工具仍走普通行，
// 且普通行不再被记忆工具污染。

import { describe, expect, test } from "bun:test";
import { createInstance } from "i18next";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { initReactI18next } from "react-i18next/initReactI18next";
import { ToolCallGroup } from "../chat/timeline/ToolCallGroup";
import type { ToolCallData, ToolCallEntry } from "../chat/types";
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

function entry(overrides: Partial<ToolCallData> = {}): ToolCallEntry {
  return {
    type: "tool_call",
    toolCall: {
      id: "tool-1",
      title: "mcp__hindsight__agent_knowledge_recall",
      status: "complete",
      rawInput: { query: "项目 YX-20261013 的负责人" },
      rawOutput: { results: [{ id: "mem-1" }, { id: "mem-2" }] },
      ...overrides,
    },
  };
}

function renderGroup(entries: ToolCallEntry[]): string {
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(ToolCallGroup, { entries })));
}

describe("ToolCallGroup 记忆工具分流", () => {
  // MCP 形态的记忆检索必须渲染为记忆卡片：带“搜索记忆”语义与相关记忆条数，且不出现网页搜索文案。
  test("MCP 形态的记忆检索渲染为记忆卡片而非网页搜索", () => {
    const html = renderGroup([entry()]);

    expect(html).toContain("搜索记忆");
    expect(html).toContain("2 条相关记忆");
    expect(html).not.toContain("搜索网页");
  });

  // 插件注册的 MCP server 会带上插件命名空间（peri 的 `plugin_<plugin>_<server>`），仍须落进记忆卡片。
  test("带插件命名空间的 MCP 记忆检索同样渲染为记忆卡片", () => {
    const html = renderGroup([entry({ title: "mcp__plugin_hindsight-memory_hindsight__agent_knowledge_recall" })]);

    expect(html).toContain("搜索记忆");
    expect(html).not.toContain("搜索网页");
  });

  // opencode 插件形态（hindsight_recall）沿用同一张卡片。
  test("opencode 插件形态的记忆检索渲染为记忆卡片", () => {
    const html = renderGroup([entry({ title: "hindsight_recall" })]);

    expect(html).toContain("搜索记忆");
    expect(html).not.toContain("搜索网页");
  });

  // 普通工具仍按原样走普通工具行，不受记忆工具分流影响。
  test("普通工具仍渲染为普通工具行", () => {
    const html = renderGroup([
      entry({ title: "WebSearch", rawInput: { query: "hindsight 是什么" }, rawOutput: { count: 3 } }),
    ]);

    expect(html).toContain("搜索网页");
  });
});
