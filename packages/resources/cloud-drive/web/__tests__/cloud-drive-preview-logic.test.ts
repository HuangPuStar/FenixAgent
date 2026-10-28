// web/__tests__/cloud-drive-preview-logic.test.ts
// 预览策略与分页聚合的纯逻辑：类型矩阵（哪些类型走 markdown / 栅格 / 不支持）、游标循环、
// 页数与体积上限、「加载更多」的起始游标，以及轮询退避序列。
//
// 这些规则不依赖 DOM；写错时界面只会表现为「内容缺失」或「一直加载」，因此在这里逐条钉住。

import { describe, expect, test } from "bun:test";
import {
  collectMarkdownPages,
  PREVIEW_MARKDOWN_CHAR_LIMIT,
  PREVIEW_MARKDOWN_PAGE_LIMIT,
  PREVIEW_POLL_DELAYS_MS,
  previewPollDelay,
} from "../lib/preview";
import { isOfficePreviewName, previewKindFor } from "../lib/preview-kind";
import type { CloudDriveMarkdownPage } from "../types/cloud-drive";

function markdownPage(content: string, nextCursor: string | null, overrides: Partial<CloudDriveMarkdownPage> = {}) {
  return {
    content,
    nextCursor,
    versionId: "version-1",
    conversionStatus: "ready",
    truncated: false,
    ...overrides,
  } satisfies CloudDriveMarkdownPage;
}

describe("云盘预览类型矩阵", () => {
  // 文本与 Office 走 markdown：上游对 Office 的栅格依赖不可用（503），markdown 才是可用通路。
  test("文本与 Office 走 markdown", () => {
    for (const name of ["README.md", "notes.txt", "app.log", "data.csv", "报告.docx", "sheet.xlsx", "deck.pptx"]) {
      expect([name, previewKindFor(name)]).toEqual([name, "markdown"]);
    }
  });

  // PDF 与图片走栅格页图；图片单页，PDF 多页。
  test("PDF 与图片走栅格", () => {
    for (const name of ["text.pdf", "photo.png", "scan.JPG", "image.webp", "doc.tiff"]) {
      expect([name, previewKindFor(name)]).toEqual([name, "raster"]);
    }
  });

  // 未收录的类型明确不支持，避免发出必然失败的预览请求。
  test("未知类型与无扩展名不支持", () => {
    for (const name of ["archive.zip", "video.mp4", "binary", "noext"]) {
      expect([name, previewKindFor(name)]).toEqual([name, "unsupported"]);
    }
  });

  // Office 判断用于栅格 503 的 markdown 回退，大小写与扩展名都要正确。
  test("Office 扩展名识别不区分大小写", () => {
    expect(isOfficePreviewName("REPORT.DOCX")).toBe(true);
    expect(isOfficePreviewName("sheet.xlsx")).toBe(true);
    expect(isOfficePreviewName("text.pdf")).toBe(false);
  });
});

describe("markdown 分页聚合", () => {
  // 沿 nextCursor 取完所有页，并保留第一页的版本与转换状态。
  test("按游标聚合全部页", async () => {
    const cursors: Array<string | undefined> = [];
    const pages = new Map<string, CloudDriveMarkdownPage>([
      ["", markdownPage("一", "c2")],
      ["c2", markdownPage("二", "c3")],
      ["c3", markdownPage("三", null)],
    ]);

    const result = await collectMarkdownPages(async (cursor) => {
      cursors.push(cursor);
      return pages.get(cursor ?? "") ?? markdownPage("", null);
    });

    expect(cursors).toEqual([undefined, "c2", "c3"]);
    expect(result.content).toBe("一\n\n二\n\n三");
    expect(result.nextCursor).toBeNull();
    expect(result.versionId).toBe("version-1");
    expect(result.pages).toBe(3);
  });

  // 达到页数上限时停止，并保留游标供「加载更多」继续。
  test("达到页数上限时保留 nextCursor", async () => {
    let calls = 0;
    const result = await collectMarkdownPages(
      async () => {
        calls += 1;
        return markdownPage(`第${calls}页`, `cursor-${calls}`);
      },
      { maxPages: 2 },
    );

    expect(calls).toBe(2);
    expect(result.pages).toBe(2);
    expect(result.nextCursor).toBe("cursor-2");
  });

  // 达到字符上限时同样停止；已取到的正文不能丢。
  test("达到字符上限时停止且保留正文", async () => {
    let calls = 0;
    const result = await collectMarkdownPages(
      async () => {
        calls += 1;
        return markdownPage("a".repeat(60), "next");
      },
      { maxChars: 100 },
    );

    expect(calls).toBe(2);
    expect(result.content.length).toBeGreaterThanOrEqual(100);
    expect(result.nextCursor).toBe("next");
  });

  // 「加载更多」从给定游标开始，而不是回到第一页。
  test("加载更多从指定游标开始", async () => {
    const cursors: Array<string | undefined> = [];
    const result = await collectMarkdownPages(
      async (cursor) => {
        cursors.push(cursor);
        return markdownPage("续", null);
      },
      { cursor: "tail" },
    );

    expect(cursors).toEqual(["tail"]);
    expect(result.content).toBe("续");
  });

  // 服务端截断标记必须向界面透出，但不应中断后续页。
  test("汇总 truncated 标记", async () => {
    const result = await collectMarkdownPages(async (cursor) =>
      cursor ? markdownPage("二", null, { truncated: true }) : markdownPage("一", "c2"),
    );

    expect(result.truncated).toBe(true);
  });
});

describe("转换轮询节奏", () => {
  // 退避序列逐档递增，超出后用最后一档，避免无限密集轮询。
  test("退避序列递增且封顶", () => {
    expect(PREVIEW_POLL_DELAYS_MS.length).toBeGreaterThan(1);
    for (let index = 1; index < PREVIEW_POLL_DELAYS_MS.length; index += 1) {
      expect(PREVIEW_POLL_DELAYS_MS[index] ?? 0).toBeGreaterThan(PREVIEW_POLL_DELAYS_MS[index - 1] ?? 0);
    }
    expect(previewPollDelay(0)).toBe(PREVIEW_POLL_DELAYS_MS[0] ?? 0);
    expect(previewPollDelay(999)).toBe(PREVIEW_POLL_DELAYS_MS.at(-1) ?? 0);
    expect(previewPollDelay(-1)).toBe(PREVIEW_POLL_DELAYS_MS[0] ?? 0);
  });

  // 页数/字符上限是常量而不是魔法值：导出后组件与测试共用一份。
  test("分页上限为预期的保守值", () => {
    expect(PREVIEW_MARKDOWN_PAGE_LIMIT).toBe(8);
    expect(PREVIEW_MARKDOWN_CHAR_LIMIT).toBe(512 * 1024);
  });
});
