import type {
  CloudDriveSearchFileResult,
  CloudDriveSearchHit,
  CloudDriveSearchSnippet,
  CloudDriveSearchSnippetMatch,
} from "../schemas/cloud-drive.schema";

/**
 * 搜索命中的服务端聚合：CloudDrive 按 chunk 返回命中（一个文件可能有多条），本模块把同一文件
 * 折叠成一条结果，并从原始 chunk 文本里截取命中上下文、计算高亮区间。
 *
 * 为什么在服务端做：上游 Meilisearch 返回的是整段 chunk（数百到数千字符），既没有高亮标记也没有
 * 裁剪；直接交给前端会让每个结果都变成一大段正文，也迫使浏览器为每个文件重复处理相同文本。
 *
 * 输出约束：片段永远是纯文本，`matches` 是 UTF-16 code unit 区间；HTML 转义由前端渲染层负责，
 * 本模块不生成、也不信任任何 HTML。
 */

/** 单条高亮区间：`[start, end)`，单位是 JavaScript 字符串下标（UTF-16 code unit）。 */
export type SearchSnippetMatch = CloudDriveSearchSnippetMatch;

/** 一段命中上下文；`matches` 已按出现顺序排序且互不重叠。 */
export type SearchSnippet = CloudDriveSearchSnippet;

/** 聚合后的单个文件结果。 */
export type AggregatedSearchFile = CloudDriveSearchFileResult;

export interface AggregatedSearchPage {
  readonly items: CloudDriveSearchFileResult[];
  readonly nextCursor: string | null;
  readonly matchCount: number;
  readonly truncated: boolean;
}

export interface SearchAggregationOptions {
  /** 最多保留多少个文件（按上游相关性顺序）。 */
  readonly maxFiles: number;
  /** 每个文件最多保留几段片段。 */
  readonly maxSnippetsPerFile?: number;
  /** 片段目标长度（含上下文），默认 220。 */
  readonly snippetChars?: number;
  /** 命中词前后至少保留的上下文长度，默认 60。 */
  readonly contextChars?: number;
}

const DEFAULT_MAX_SNIPPETS = 3;
const DEFAULT_SNIPPET_CHARS = 220;
const DEFAULT_CONTEXT_CHARS = 60;
const MAX_QUERY_TERMS = 8;
const MAX_MATCHES_PER_TERM = 100;
const MAX_WINDOW_ANCHORS = 40;

/**
 * 把上游 chunk 命中聚合成文件级结果。
 *
 * 顺序策略：文件保持上游首次出现的顺序（Meilisearch 的相关性排序）；文件内片段按命中数降序，
 * 相同命中数保持上游顺序。最终按 `maxFiles` 截断，`truncated` 表示还有文件被丢弃。
 */
export function aggregateSearchHits(
  hits: readonly CloudDriveSearchHit[],
  query: string,
  options: SearchAggregationOptions,
): AggregatedSearchPage {
  const maxFiles = Math.max(0, Math.floor(options.maxFiles));
  const maxSnippets = options.maxSnippetsPerFile ?? DEFAULT_MAX_SNIPPETS;
  const snippetChars = options.snippetChars ?? DEFAULT_SNIPPET_CHARS;
  const contextChars = options.contextChars ?? DEFAULT_CONTEXT_CHARS;
  const terms = queryTerms(query);

  interface Candidate {
    readonly snippet: SearchSnippet;
    readonly order: number;
    readonly matchCount: number;
  }

  interface Bucket {
    readonly first: CloudDriveSearchHit;
    readonly order: number;
    readonly candidates: Candidate[];
    occurrenceCount: number;
  }

  const buckets = new Map<string, Bucket>();
  let hitOrder = 0;

  for (const hit of hits) {
    let bucket = buckets.get(hit.fileId);
    if (!bucket) {
      bucket = { first: hit, order: hitOrder, candidates: [], occurrenceCount: 0 };
      buckets.set(hit.fileId, bucket);
    }
    hitOrder += 1;

    const built = buildSnippet(hit.snippet, terms, snippetChars, contextChars);
    if (!built) continue;
    // 同一文件的不同 chunk 可能产生完全相同的片段（短文件、重复段落），按文本去重。
    if (bucket.candidates.some((candidate) => candidate.snippet.text === built.snippet.text)) continue;
    bucket.occurrenceCount += built.occurrenceCount;
    bucket.candidates.push({ snippet: built.snippet, order: hitOrder, matchCount: built.occurrenceCount });
  }

  const files: AggregatedSearchFile[] = [];
  for (const bucket of [...buckets.values()].sort((a, b) => a.order - b.order)) {
    // 命中来自标题/路径时，chunk 正文里没有查询词：只保留第一段作摘要，避免同一文件刷出多段无关正文。
    const matched = bucket.candidates.filter((candidate) => candidate.matchCount > 0);
    const pool = matched.length > 0 ? matched : bucket.candidates.slice(0, 1);
    const sorted = pool
      .sort((a, b) => b.matchCount - a.matchCount || a.order - b.order)
      .slice(0, Math.max(0, maxSnippets));
    const first = bucket.first;
    const snippets = sorted.map((candidate) => candidate.snippet);
    files.push({
      fileId: first.fileId,
      name: fileNameFromPath(first.path) || first.fileId,
      path: first.path,
      parentId: null,
      kind: "file",
      sizeBytes: null,
      updatedAt: null,
      snippets,
      matchCount: bucket.occurrenceCount,
      location: { page: first.location.page, block: first.location.block },
      completeness: {
        status: first.completeness.status,
        missingTextPages: first.completeness.missingTextPages,
      },
      stale: first.stale,
      currentVersionId: first.currentVersionId,
      returnedVersionId: first.returnedVersionId,
      newerVersionStatus: first.newerVersionStatus,
      snippet: snippets[0]?.text ?? "",
    });
  }

  const items = files.slice(0, maxFiles);
  return {
    items,
    nextCursor: null,
    matchCount: items.reduce((total, file) => total + file.matchCount, 0),
    truncated: files.length > items.length,
  };
}

/** 从业务绝对路径取最后一段作为展示名；路径为空时返回空串，由调用方回退到 fileId。 */
export function fileNameFromPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

interface BuiltSnippet {
  readonly snippet: SearchSnippet;
  /** 整段文本内的命中位置数（不只是窗口内），用于文件级「N 处匹配」。 */
  readonly occurrenceCount: number;
}

function buildSnippet(
  raw: string,
  terms: readonly string[],
  snippetChars: number,
  contextChars: number,
): BuiltSnippet | null {
  const text = normalizeText(raw);
  if (!text) return null;

  const allMatches = mergeMatches(terms.flatMap((term) => findTermMatches(text, term, MAX_MATCHES_PER_TERM)));
  if (allMatches.length === 0) {
    const end = Math.min(text.length, snippetChars);
    return {
      snippet: {
        text: text.slice(0, end),
        matches: [],
        leadingEllipsis: false,
        trailingEllipsis: end < text.length,
      },
      occurrenceCount: 0,
    };
  }

  const window = densestWindow(text, allMatches, snippetChars, contextChars);
  let start = window.start;
  let end = window.end;
  const firstIncluded = allMatches.find((match) => match.start >= start && match.end <= end);
  const lastIncluded = [...allMatches].reverse().find((match) => match.start >= start && match.end <= end);

  if (firstIncluded && lastIncluded) {
    start = alignStart(text, start, firstIncluded.start);
    end = alignEnd(text, end, lastIncluded.end);
    start = avoidLowSurrogateStart(text, start);
    end = avoidLowSurrogateEnd(text, end);
    while (start < firstIncluded.start && text[start] === " ") start += 1;
    while (end > lastIncluded.end && text[end - 1] === " ") end -= 1;
    if (start > end) {
      start = window.start;
      end = window.end;
    }
  }

  const matches = allMatches
    .filter((match) => match.start >= start && match.end <= end)
    .map((match) => ({ start: match.start - start, end: match.end - start }));

  return {
    snippet: {
      text: text.slice(start, end),
      matches,
      leadingEllipsis: start > 0,
      trailingEllipsis: end < text.length,
    },
    occurrenceCount: allMatches.length,
  };
}

/** 归一化正文：控制字符与所有空白折叠成单个空格，避免片段里出现大段换行。 */
function normalizeText(raw: string): string {
  let cleaned = "";
  for (const char of raw) {
    const code = char.codePointAt(0) ?? 0;
    const control = (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f;
    cleaned += control ? " " : char;
  }
  return cleaned.replace(/\s+/g, " ").trim();
}

/** 查询词：整句 + 空白分隔的词；整句优先，便于高亮连续短语。 */
function queryTerms(query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const terms: string[] = [];
  const seen = new Set<string>();
  const push = (term: string) => {
    const normalized = term.trim();
    if (!normalized || terms.length >= MAX_QUERY_TERMS) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    terms.push(normalized);
  };
  push(trimmed);
  for (const part of trimmed.split(/\s+/)) push(part);
  return terms;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 用带 `u` 标志的大小写不敏感正则找原文下标，避免 `toLowerCase()` 改变字符串长度导致区间错位。 */
function findTermMatches(text: string, term: string, limit: number): SearchSnippetMatch[] {
  if (!term) return [];
  let pattern: RegExp;
  try {
    pattern = new RegExp(escapeRegExp(term), "giu");
  } catch {
    // 极端输入（例如 JSON 里的孤立代理项）无法构造 Unicode 正则：当作没有命中，不影响搜索结果。
    return [];
  }
  const matches: SearchSnippetMatch[] = [];
  for (let match = pattern.exec(text); match !== null && matches.length < limit; match = pattern.exec(text)) {
    if (match[0].length === 0) {
      pattern.lastIndex += 1;
      continue;
    }
    matches.push({ start: match.index, end: match.index + match[0].length });
  }
  return matches;
}

/** 合并重叠区间（整句与单词命中会重叠），保持出现顺序。 */
function mergeMatches(matches: readonly SearchSnippetMatch[]): SearchSnippetMatch[] {
  const sorted = [...matches].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const match of sorted) {
    const last = merged[merged.length - 1];
    if (last && match.start <= last.end) {
      last.end = Math.max(last.end, match.end);
      continue;
    }
    merged.push({ start: match.start, end: match.end });
  }
  return merged;
}

/** 在命中词周围取窗口，优先选择覆盖命中数最多的位置；同分取更靠前的窗口。 */
function densestWindow(
  text: string,
  matches: readonly SearchSnippetMatch[],
  snippetChars: number,
  contextChars: number,
): { start: number; end: number } {
  let best = { start: 0, end: Math.min(text.length, snippetChars), count: -1 };
  for (const anchor of matches.slice(0, MAX_WINDOW_ANCHORS)) {
    let start = Math.max(0, anchor.start - contextChars);
    const end = Math.min(text.length, start + snippetChars);
    if (end - start < snippetChars) start = Math.max(0, end - snippetChars);
    const count = matches.filter((match) => match.start >= start && match.end <= end).length;
    if (count > best.count) best = { start, end, count };
  }
  return { start: best.start, end: best.end };
}

/** 起点落在词中间时向后挪到下一个空格；不越过第一个命中，避免把命中词切掉。 */
function alignStart(text: string, start: number, firstMatchStart: number): number {
  if (start <= 0) return 0;
  const limit = Math.min(text.length, start + 20);
  const space = text.indexOf(" ", start);
  return space >= 0 && space < limit && space < firstMatchStart ? space + 1 : start;
}

/** 终点落在词中间时向前挪到上一个空格；不越过最后一个命中。 */
function alignEnd(text: string, end: number, lastMatchEnd: number): number {
  if (end >= text.length) return text.length;
  const floor = Math.max(0, end - 20);
  const space = text.lastIndexOf(" ", end);
  return space >= floor && space > lastMatchEnd ? space : end;
}

function avoidLowSurrogateStart(text: string, start: number): number {
  return start > 0 && isLowSurrogate(text.charCodeAt(start)) ? start - 1 : start;
}

function avoidLowSurrogateEnd(text: string, end: number): number {
  return end < text.length && isLowSurrogate(text.charCodeAt(end)) ? end + 1 : end;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
