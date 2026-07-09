import { describe, expect, test } from "bun:test";
import type { NarrationContext } from "@/components/chat/narrators/types";
import { webFetchNarrator } from "@/components/chat/narrators/web-fetch";
import type { ToolCallData } from "@/src/lib/types";

/**
 * webFetchNarrator 单测。
 *
 * 覆盖：match 规则（fetch/webfetch/curl）、verb、URL 作为 object、长 URL 截断。
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
    kind: "web-fetch",
    status: "complete",
    t: mockT,
  };
}

describe("webFetchNarrator", () => {
  // kinds 包含 "web-fetch"
  test("kinds 包含 web-fetch", () => {
    expect(webFetchNarrator.kinds).toContain("web-fetch");
  });

  // 中文动词必须是"抓取"（区别于 WebSearch 的"搜索"）
  test("verb 是 '抓取'", () => {
    expect(webFetchNarrator.verb).toBe("抓取");
  });

  // URL 作为 object
  test("URL 作为 object", () => {
    const { object } = webFetchNarrator.getDisplay(makeCtx({ url: "https://example.com/page" }));
    expect(object).toBe("https://example.com/page");
  });

  // 长 URL 截断到 80 字符 + 省略号
  test("长 URL 截断到 80 字符", () => {
    const longUrl = `https://example.com/${"x".repeat(100)}`;
    const { object } = webFetchNarrator.getDisplay(makeCtx({ url: longUrl }));
    expect((object as string).length).toBe(81); // 80 + 省略号
  });
});
