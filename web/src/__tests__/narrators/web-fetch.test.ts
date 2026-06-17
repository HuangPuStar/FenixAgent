import { describe, expect, test } from "bun:test";
import type { NarrationContext } from "@/components/chat/narrators/types";
import { webFetchNarrator } from "@/components/chat/narrators/web-fetch";
import type { ToolCallData } from "@/src/lib/types";

/**
 * webFetchNarrator 单测。
 *
 * 覆盖：match 规则（fetch/webfetch/curl）、verb、URL 作为 title、长 URL 截断。
 */

const mockT = ((key: string) => key) as unknown as NarrationContext["t"];

function makeCtx(rawInput: unknown): NarrationContext {
  return {
    tool: {
      id: "t1",
      title: "WebFetch",
      status: "complete",
      rawInput: rawInput as Record<string, unknown>,
    } as ToolCallData,
    status: "complete",
    t: mockT,
  };
}

describe("webFetchNarrator", () => {
  // 匹配 fetch / webfetch / curl 三种命名变体，read 不命中
  test("匹配 fetch/webfetch/curl", () => {
    expect(webFetchNarrator.match("fetch")).toBe(true);
    expect(webFetchNarrator.match("webfetch")).toBe(true);
    expect(webFetchNarrator.match("curl")).toBe(true);
    expect(webFetchNarrator.match("read")).toBe(false);
  });

  // 中文动词必须是"抓"（区别于 WebSearch 的"搜"）
  test("verb 是 '抓'", () => {
    expect(webFetchNarrator.verb).toBe("抓");
  });

  // URL 同时作为 title 和 object
  test("URL 作为 title 和 object", () => {
    const { title, object } = webFetchNarrator.getDisplay(makeCtx({ url: "https://example.com/page" }));
    expect(title).toBe("https://example.com/page");
    expect(object).toBe("https://example.com/page");
  });

  // 长 URL 截断到 80 字符 + 省略号
  test("长 URL 截断到 80 字符", () => {
    const longUrl = `https://example.com/${"x".repeat(100)}`;
    const { title } = webFetchNarrator.getDisplay(makeCtx({ url: longUrl }));
    expect((title as string).length).toBe(81); // 80 + 省略号
  });
});
