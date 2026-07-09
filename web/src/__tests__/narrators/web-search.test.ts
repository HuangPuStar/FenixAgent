import { describe, expect, test } from "bun:test";
import type { NarrationContext } from "@/components/chat/narrators/types";
import { webSearchNarrator } from "@/components/chat/narrators/web-search";
import type { ToolCallData } from "@/src/lib/types";

/**
 * webSearchNarrator 单测。
 *
 * 覆盖：match 规则（search/websearch/web_search）、verb、query 加引号作为 object、
 * search 字段兼容、complete 状态从 rawOutput.count 提取结果数作为 detail。
 */

const mockT = ((key: string, opts?: Record<string, unknown>) => {
  if (key === "webSearch.results") return `找到 ${opts?.count} 个`;
  return key;
}) as unknown as NarrationContext["t"];

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
    t: mockT,
  };
}

describe("webSearchNarrator", () => {
  // kinds 包含 "web-search"
  test("kinds 包含 web-search", () => {
    expect(webSearchNarrator.kinds).toContain("web-search");
  });

  // 中文动词必须是"搜索"（与 Grep 同词，但 Grep 是本地代码搜索）
  test("verb 是 '搜索'", () => {
    expect(webSearchNarrator.verb).toBe("搜索");
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
