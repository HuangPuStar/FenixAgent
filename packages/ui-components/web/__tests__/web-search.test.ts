import { describe, expect, test } from "bun:test";
import { createInstance } from "i18next";
import type { NarrationContext } from "../chat/narrators/types";
import { webSearchNarrator } from "../chat/narrators/web-search";
import type { ToolCallData } from "../chat/types";
import zh from "../i18n/locales/zh/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";

/**
 * webSearchNarrator 单测。
 *
 * 覆盖：match 规则（search/websearch/web_search）、verb、query 加引号作为 object、
 * search 字段兼容、complete 状态从 rawOutput.count 提取结果数作为 detail。
 *
 * 来源：`packages/agent-runtime/web/__tests__/web-search.test.ts` 逐字迁移，
 * 仅改写导入路径（narrator / 类型改指包内 `../chat/**`），并把 i18n 从旧用例里
 * 手写的 mock `t` 换成包内 `locales/zh/uiComponents.json` 的 `chat.toolNarrator`
 * 子树——包内 narrator 的 key 统一带 `chat.toolNarrator.` 前缀，字典译文与原
 * mock 返回的 "找到 N 个" 一致，故 detail 断言维持原值。
 */

// 初始化测试用 i18n 实例（绑定到包内 uiComponents 命名空间，使用中文字典）
// 不使用 initReactI18next —— 测试不依赖 React context，直接用 i18next 原生 API 即可
const i18n = createInstance();
void i18n.init({
  resources: { zh: { [UI_COMPONENTS_NS]: zh } },
  lng: "zh",
  ns: [UI_COMPONENTS_NS],
  defaultNS: UI_COMPONENTS_NS,
  initAsync: false,
  interpolation: { escapeValue: false },
});

const t = i18n.getFixedT("zh", UI_COMPONENTS_NS);

function makeCtx(
  rawInput: unknown,
  rawOutput?: unknown,
  status: NarrationContext["status"] = "complete",
): NarrationContext {
  return {
    tool: {
      id: "t1",
      title: "WebSearch",
      status: status as ToolCallData["status"],
      rawInput: rawInput as Record<string, unknown>,
      rawOutput: rawOutput as Record<string, unknown> | undefined,
    } as ToolCallData,
    kind: "web-search",
    status,
    t,
  };
}

describe("webSearchNarrator", () => {
  // kinds 包含 "web-search"
  test("kinds 包含 web-search", () => {
    expect(webSearchNarrator.kinds).toContain("web-search");
  });

  // 中文动作必须明确表达网页搜索行为
  test("verb 是 '搜索网页'", () => {
    expect(webSearchNarrator.verb).toBe("搜索网页");
  });

  // query 字段加双引号作为 object（强调搜索词文本）
  test("query 加引号作为 object", () => {
    const { object } = webSearchNarrator.getDisplay(makeCtx({ query: "claude code" }));
    expect(object).toBe('"claude code"');
  });

  // 兼容 search 字段
  test("兼容 search 字段", () => {
    const { object } = webSearchNarrator.getDisplay(makeCtx({ search: "hello" }));
    expect(object).toBe('"hello"');
  });

  // complete 状态从 rawOutput.count 提取结果数作为 detail
  test("complete 状态有结果数 detail", () => {
    const { detail } = webSearchNarrator.getDisplay(makeCtx({ query: "x" }, { count: 8 }));
    expect(detail).toBe("找到 8 个");
  });
});
