import { describe, expect, test } from "bun:test";
import type { NarrationContext } from "@/components/chat/narrators/types";
import { webSearchNarrator } from "@/components/chat/narrators/web-search";
import type { ToolCallData } from "@/src/lib/types";

/**
 * webSearchNarrator 单测。
 *
 * 覆盖：match 规则（search/websearch/web_search）、verb、query 加引号、search 字段兼容、
 * complete 状态从 rawOutput.count 提取结果数徽章。
 */

const mockT = ((key: string, opts?: Record<string, unknown>) => {
  if (key === "toolNarrator.webSearch.results") return `找到 ${opts?.count} 个`;
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
    status,
    t: mockT,
  };
}

describe("webSearchNarrator", () => {
  // 匹配 search / websearch / web_search 三种命名变体，grep 不命中
  test("匹配 search/websearch", () => {
    expect(webSearchNarrator.match("search")).toBe(true);
    expect(webSearchNarrator.match("websearch")).toBe(true);
    expect(webSearchNarrator.match("web_search")).toBe(true);
    expect(webSearchNarrator.match("grep")).toBe(false);
  });

  // 中文动词必须是"搜"（与 Grep 同字，但 Grep 是本地代码搜索）
  test("verb 是 '搜'", () => {
    expect(webSearchNarrator.verb).toBe("搜");
  });

  // query 字段加双引号作为 title（强调搜索词文本）
  test("query 加引号作为 title", () => {
    const { title } = webSearchNarrator.getDisplay(makeCtx({ query: "claude code" }));
    expect(title).toBe('"claude code"');
  });

  // 兼容 search 字段
  test("兼容 search 字段", () => {
    const { title } = webSearchNarrator.getDisplay(makeCtx({ search: "hello" }));
    expect(title).toBe('"hello"');
  });

  // complete 状态从 rawOutput.count 提取结果数徽章
  test("complete 状态有结果数徽章", () => {
    const ctx = makeCtx({ query: "x" }, { count: 8 });
    expect(webSearchNarrator.badge?.(ctx)?.text).toBe("找到 8 个");
  });
});
