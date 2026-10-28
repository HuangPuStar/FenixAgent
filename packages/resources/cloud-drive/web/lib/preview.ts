/**
 * 预览取数的纯逻辑：markdown 分页聚合与转换轮询节奏。
 *
 * 放在 `lib/` 而不是 hook 里，是为了在不挂载 React 的情况下验证「游标循环 / 页数与体积上限 /
 * 退避序列」——这些规则一旦写错，界面只会表现为「内容少了」或「一直转圈」，很难从 DOM 断言发现。
 */

import type { CloudDriveMarkdownPage } from "../types/cloud-drive";

/** 一次预览最多自动聚合的 markdown 页数；超出后由用户点「加载更多」继续。 */
export const PREVIEW_MARKDOWN_PAGE_LIMIT = 8;

/** 一次预览聚合的正文上限（字符数）；防止超长文档让渲染层长时间无响应。 */
export const PREVIEW_MARKDOWN_CHAR_LIMIT = 512 * 1024;

/** 转换轮询总预算：超过后展示超时并提供重试，而不是无限轮询。 */
export const PREVIEW_POLL_BUDGET_MS = 30_000;

/** 轮询退避序列（毫秒）；末档重复用于剩余预算。 */
export const PREVIEW_POLL_DELAYS_MS = [800, 1_200, 1_800, 2_500, 3_500, 5_000] as const;

export interface CollectedMarkdown {
  readonly content: string;
  readonly nextCursor: string | null;
  readonly versionId: string;
  readonly conversionStatus: string | null;
  /** 是否因服务端单页上限被截断（正常不会出现）。 */
  readonly truncated: boolean;
  /** 本次实际聚合的页数。 */
  readonly pages: number;
}

export interface CollectMarkdownOptions {
  readonly maxPages?: number;
  readonly maxChars?: number;
  /** 起始游标；「加载更多」从上一批的 nextCursor 继续。 */
  readonly cursor?: string;
}

/**
 * 按游标聚合若干页 markdown。
 *
 * 停止条件：没有下一页、达到页数上限、或达到字符上限。后两种都会保留 `nextCursor`，调用方据此展示
 * 「加载更多」；已经取到的正文不会因为停止而丢失。
 */
export async function collectMarkdownPages(
  fetchPage: (cursor?: string) => Promise<CloudDriveMarkdownPage>,
  options: CollectMarkdownOptions = {},
): Promise<CollectedMarkdown> {
  const maxPages = options.maxPages ?? PREVIEW_MARKDOWN_PAGE_LIMIT;
  const maxChars = options.maxChars ?? PREVIEW_MARKDOWN_CHAR_LIMIT;
  const parts: string[] = [];
  let cursor: string | undefined = options.cursor;
  let versionId = "";
  let conversionStatus: string | null = null;
  let truncated = false;
  let characters = 0;
  let pages = 0;

  while (pages < maxPages) {
    const page = await fetchPage(cursor);
    versionId = page.versionId || versionId;
    conversionStatus = page.conversionStatus ?? conversionStatus;
    truncated = truncated || page.truncated;
    parts.push(page.content);
    characters += page.content.length;
    pages += 1;
    cursor = page.nextCursor ?? undefined;
    if (!cursor) break;
    if (characters >= maxChars) break;
  }

  return {
    content: parts.join("\n\n"),
    nextCursor: cursor ?? null,
    versionId,
    conversionStatus,
    truncated,
    pages,
  };
}

/** 第 `attempt` 次轮询前的等待时间；序列用尽后保持最后一档。 */
export function previewPollDelay(attempt: number): number {
  const index = Math.min(Math.max(attempt, 0), PREVIEW_POLL_DELAYS_MS.length - 1);
  return PREVIEW_POLL_DELAYS_MS[index] ?? 5_000;
}
