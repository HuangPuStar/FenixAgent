import { describe, expect, test } from "bun:test";
import { aggregateSearchHits, fileNameFromPath } from "../server/search/search-result";
import { makeSearchHit } from "./cloud-drive-fixtures";

const OPTIONS = { maxFiles: 20, maxSnippetsPerFile: 3 };

describe("CloudDrive 搜索聚合", () => {
  // 业务意图：同一文件的多个 chunk 命中必须合并为一条结果，重复片段只保留一次。
  test("同一文件的多个命中合并为一条并去掉重复片段", () => {
    const page = aggregateSearchHits(
      [
        makeSearchHit({ snippet: "alpha beta gamma" }),
        makeSearchHit({ snippet: "alpha beta gamma" }),
        makeSearchHit({ snippet: "another alpha paragraph" }),
      ],
      "alpha",
      OPTIONS,
    );

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.snippets).toHaveLength(2);
    expect(page.items[0]?.snippet).toBe(page.items[0]?.snippets[0]?.text);
    expect(page.matchCount).toBe(2);
  });

  // 业务意图：片段按命中密度排序，最相关的一段放在第一位；最多保留 3 段。
  test("每文件最多 3 段并按命中数排序", () => {
    const page = aggregateSearchHits(
      [
        makeSearchHit({ snippet: "needle one" }),
        makeSearchHit({ snippet: "needle needle two" }),
        makeSearchHit({ snippet: "needle three" }),
        makeSearchHit({ snippet: "needle four" }),
      ],
      "needle",
      OPTIONS,
    );

    expect(page.items[0]?.snippets).toHaveLength(3);
    expect(page.items[0]?.snippets[0]?.matches).toHaveLength(2);
    expect(page.items[0]?.matchCount).toBe(5);
  });

  // 业务意图：总文件数受 maxFiles 限制，并明确标记结果被截断。
  test("文件数上限与截断标记", () => {
    const page = aggregateSearchHits(
      [
        makeSearchHit({ fileId: "f1", path: "/a.txt" }),
        makeSearchHit({ fileId: "f2", path: "/b.txt" }),
        makeSearchHit({ fileId: "f3", path: "/c.txt" }),
      ],
      "report",
      { maxFiles: 2, maxSnippetsPerFile: 3 },
    );

    expect(page.items.map((item) => item.fileId)).toEqual(["f1", "f2"]);
    expect(page.truncated).toBe(true);
  });

  // 业务意图：长正文必须围绕命中词截断，保留前后上下文并给出可用的高亮区间。
  test("长正文截断到约 220 字符并保留命中上下文", () => {
    const raw = `${"prefix ".repeat(80)}needle in the middle${" suffix".repeat(80)}`;
    const page = aggregateSearchHits([makeSearchHit({ snippet: raw })], "needle", OPTIONS);
    const snippet = page.items[0]?.snippets[0];

    expect(snippet?.text.length).toBeLessThanOrEqual(222);
    expect(snippet?.leadingEllipsis).toBe(true);
    expect(snippet?.trailingEllipsis).toBe(true);
    expect(snippet?.text).toContain("needle in the middle");
    const match = snippet?.matches[0];
    expect(match && snippet?.text.slice(match.start, match.end)).toBe("needle");
  });

  // 业务意图：UTF-16 区间必须按原始字符串下标计算，emoji 与中文都不能错位。
  test("emoji 与中文的命中区间正确", () => {
    const page = aggregateSearchHits([makeSearchHit({ snippet: "😀😀 命中词 前后文 😀" })], "命中词", OPTIONS);
    const snippet = page.items[0]?.snippets[0];
    const match = snippet?.matches[0];

    expect(match && snippet?.text.slice(match.start, match.end)).toBe("命中词");
    expect(snippet?.text).not.toMatch(/^[\udc00-\udfff]|[\ud800-\udbff]$/);
  });

  // 业务意图：多个关键词分别命中时返回多个区间，而不是只高亮第一个词。
  test("空格分隔的多个关键词分别高亮", () => {
    const page = aggregateSearchHits([makeSearchHit({ snippet: "alpha and beta together" })], "alpha beta", OPTIONS);
    const snippet = page.items[0]?.snippets[0];

    expect(snippet?.matches).toHaveLength(2);
    expect(snippet?.text.slice(snippet.matches[0]?.start, snippet.matches[0]?.end)).toBe("alpha");
    expect(snippet?.text.slice(snippet.matches[1]?.start, snippet.matches[1]?.end)).toBe("beta");
  });

  // 业务意图：查询词不区分大小写；命中区间仍指向原文。
  test("大小写不敏感匹配", () => {
    const page = aggregateSearchHits([makeSearchHit({ snippet: "The Quarterly REPORT is ready" })], "report", OPTIONS);
    const snippet = page.items[0]?.snippets[0];
    const match = snippet?.matches[0];

    expect(match && snippet?.text.slice(match.start, match.end)).toBe("REPORT");
  });

  // 业务意图：正文没有查询词（例如命中来自标题/路径）时仍给一段开头摘要，不伪造高亮。
  test("无命中词的片段返回开头摘要且不生成区间", () => {
    const raw = "no matching term here ".repeat(30);
    const page = aggregateSearchHits([makeSearchHit({ snippet: raw })], "needle", OPTIONS);
    const snippet = page.items[0]?.snippets[0];

    expect(snippet?.matches).toEqual([]);
    expect(snippet?.text.length).toBeLessThanOrEqual(220);
    expect(snippet?.trailingEllipsis).toBe(true);
    expect(page.matchCount).toBe(0);
  });

  // 业务意图：正文命中的 chunk 优先；没有命中词的 chunk 不应混进结果（标题/路径命中会返回多个 chunk）。
  test("正文命中优先于无命中词的 chunk", () => {
    const page = aggregateSearchHits(
      [
        makeSearchHit({ snippet: "unrelated text" }),
        makeSearchHit({ snippet: "needle content" }),
        makeSearchHit({ snippet: "another needle content" }),
      ],
      "needle",
      OPTIONS,
    );

    expect(page.items[0]?.snippets).toHaveLength(2);
    expect(page.items[0]?.snippets.every((snippet) => snippet.matches.length > 0)).toBe(true);
  });

  // 业务意图：整个文件只有标题/路径命中时，只给一段摘要，不把每个 chunk 都摊开。
  test("全部 chunk 无命中词时只保留一段摘要", () => {
    const page = aggregateSearchHits(
      [
        makeSearchHit({ snippet: "unrelated text" }),
        makeSearchHit({ snippet: "still unrelated text" }),
        makeSearchHit({ snippet: "again unrelated text" }),
      ],
      "needle",
      OPTIONS,
    );

    expect(page.items[0]?.snippets).toHaveLength(1);
    expect(page.items[0]?.matchCount).toBe(0);
  });

  // 业务意图：片段是纯文本，服务端不得把用户正文中的 HTML 当成标记处理或回显为标签。
  test("HTML/XSS 字符原样保留为纯文本", () => {
    const raw = '<script>alert("xss")</script> 以及 <img src=x onerror=alert(1)>';
    const page = aggregateSearchHits([makeSearchHit({ snippet: raw })], "script", OPTIONS);
    const snippet = page.items[0]?.snippets[0];

    expect(snippet?.text).toContain("<script>");
    expect(snippet?.text).not.toContain("<mark>");
    for (const match of snippet?.matches ?? []) {
      expect(snippet?.text.slice(match.start, match.end)).toBe("script");
    }
  });

  // 业务意图：空命中页不制造空文件条目。
  test("空命中返回空结果", () => {
    const page = aggregateSearchHits([], "anything", OPTIONS);

    expect(page).toEqual({ items: [], nextCursor: null, matchCount: 0, truncated: false });
  });

  // 业务意图：展示名从业务路径末段派生，根路径与空路径有确定回退。
  test("从路径派生展示名", () => {
    expect(fileNameFromPath("/验收示例/hello.md")).toBe("hello.md");
    expect(fileNameFromPath("/hello.md")).toBe("hello.md");
    expect(fileNameFromPath("/")).toBe("");
  });
});
