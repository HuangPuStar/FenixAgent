/**
 * CSS 注释的定位与移除。
 *
 * 为什么用词法器而不是 `/\*[\s\S]*?\*\//g`：`/*` 出现在两类地方时**不是**注释开头——
 * 字符串（`content: "/*"`）与未加引号的 `url()` 内容（`url(/assets/a/*.png)`）。
 * 正则会把它们当成注释删掉，直接改坏样式；这里按 CSS 词法跳过字符串与 `url()` 区域。
 *
 * 移除策略（目标是删除后重新词法分析不产生新 token，也不留下成片空白行）：
 * 1. 仅由空白分隔的连续注释合并成一段，连同其间的空白一起处理；
 * 2. 独占整行的注释块连同行首缩进与行尾换行一起删除；
 * 3. 行内注释替换为**至多一个空格**。
 *
 * 第 3 条是无奈的两难：CSS 注释在词法上不产生空白 token，删除后两侧字符可能粘连
 * （`1px` 与 `solid` 之间删掉注释会变成 `1pxsolid`，声明静默失效），补空格又会把
 * `.a` 与 `.b` 之间删掉注释的复合选择器变成后代选择器。两种风险无法同时避免，
 * 取「补空格保 token 边界」是因为粘连会产出非法值，而选择器关系变化至少仍是合法 CSS；
 * `scripts/remove-css-comments.ts` 的扫描报告会列出全部此类紧邻情形，供人工复核。
 *
 * 本模块只负责「删注释」，不做缩进与空行重排——格式统一交给 `biome format`。
 */

/** 一处 CSS 注释在源码中的位置。 */
export interface CssComment {
  /** 起始偏移（指向注释开头的斜杠）。 */
  start: number;
  /** 结束偏移（紧跟在注释闭合定界符之后；未闭合注释为源码长度）。 */
  end: number;
  /** 起始行号，1 基。 */
  line: number;
  /** 注释原文（含定界符）。 */
  text: string;
}

/** 一次移除操作的结果。 */
export interface CssCommentRemoval {
  /** 删除注释后的源码；无可删注释时与输入相同。 */
  output: string;
  /** 实际删除的注释，按位置升序。 */
  removed: CssComment[];
  /** 按保留策略跳过的注释，按位置升序。 */
  kept: CssComment[];
}

/** 移除选项。 */
export interface RemoveCssCommentsOptions {
  /**
   * 命中的注释原样保留（例如 `biome-ignore` 这类 lint 抑制指令）：
   * 它们的作用不在「记录说明」，删掉会改变工具行为。
   */
  keep?: (comment: CssComment) => boolean;
}

/** 一处合并后的删除区间：覆盖一个或多个仅由空白分隔的注释。 */
interface CommentSpan {
  start: number;
  end: number;
  comments: CssComment[];
}

/** CSS 词法空白：空格、制表、换行、回车、换页。 */
function isCssWhitespace(character: string): boolean {
  return character === " " || character === "\t" || character === "\n" || character === "\r" || character === "\f";
}

/** 仅由 CSS 空白组成的文本（含空串）。 */
function isBlank(text: string): boolean {
  for (const character of text) {
    if (!isCssWhitespace(character)) return false;
  }
  return true;
}

/** `ident` 里出现的字符，用于区分 `url(` 与 `myurl(` 这类名称结尾。 */
function isIdentCharacter(character: string): boolean {
  return /[a-zA-Z0-9_-]/.test(character) || character.charCodeAt(0) > 0x7f;
}

/**
 * 跳过从 `start`（引号）开始的字符串，返回闭合引号之后的下标。
 *
 * 反斜杠转义整体跳过两个字符（含 `\<换行>` 续行）；换行未闭合时返回换行位置，
 * 与 CSS 规范里 bad-string 在被换行打断的行为一致。
 */
function skipString(source: string, start: number): number {
  const quote = source[start];
  let index = start + 1;

  while (index < source.length) {
    const character = source[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === quote) return index + 1;
    if (character === "\n") return index;
    index += 1;
  }

  return source.length;
}

/** 判断 `index` 处是否是一个完整的 `url(`（大小写不敏感，且 `url` 不是更长标识符的结尾）。 */
function isUrlFunctionStart(source: string, index: number): boolean {
  if (source[index] !== "u" && source[index] !== "U") return false;
  if (index > 0 && isIdentCharacter(source[index - 1] as string)) return false;
  return source.slice(index, index + 4).toLowerCase() === "url(";
}

/**
 * 跳过 `url(...)`，返回右括号之后的下标（无右括号时到源码结尾）。
 *
 * url 内容允许引号形式（当作字符串继续跳过），也允许未加引号形式——
 * 后者可以合法包含 `/`、`*`，所以必须整段跳过，不能让 `/*` 冒充注释开头。
 */
function skipUrlFunction(source: string, start: number): number {
  let index = start + 4;

  while (index < source.length && isCssWhitespace(source[index] as string)) index += 1;

  const quote = index < source.length ? (source[index] as string) : "";
  if (quote === '"' || quote === "'") {
    index = skipString(source, index);
  } else {
    while (index < source.length) {
      const character = source[index];
      if (character === ")") break;
      if (character === "\\") {
        index += 2;
        continue;
      }
      index += 1;
    }
  }

  while (index < source.length && source[index] !== ")") index += 1;
  return index < source.length ? index + 1 : index;
}

/** 按 CSS 词法扫描全部注释（含未闭合注释，结束偏移取源码长度）。 */
export function findCssComments(source: string): CssComment[] {
  const comments: CssComment[] = [];
  let index = 0;
  let line = 1;

  while (index < source.length) {
    const character = source[index] as string;

    if (character === "/" && source[index + 1] === "*") {
      const closeIndex = source.indexOf("*/", index + 2);
      const end = closeIndex === -1 ? source.length : closeIndex + 2;
      comments.push({ start: index, end, line, text: source.slice(index, end) });
      line += countNewlines(source, index, end);
      index = end;
      continue;
    }

    if (character === '"' || character === "'") {
      const end = skipString(source, index);
      line += countNewlines(source, index, end);
      index = end;
      continue;
    }

    if (isUrlFunctionStart(source, index)) {
      const end = skipUrlFunction(source, index);
      line += countNewlines(source, index, end);
      index = end;
      continue;
    }

    if (character === "\n") line += 1;
    index += 1;
  }

  return comments;
}

/** 统计 `[start, end)` 区间内的换行数。 */
function countNewlines(source: string, start: number, end: number): number {
  let count = 0;
  for (let index = start; index < end; index += 1) {
    if (source[index] === "\n") count += 1;
  }
  return count;
}

/** 合并「仅由空白分隔」的连续注释，删它们时顺手吃掉中间的空白与空行。 */
function mergeAdjacentComments(source: string, comments: readonly CssComment[]): CommentSpan[] {
  const spans: CommentSpan[] = [];

  for (const comment of comments) {
    const previous = spans.at(-1);
    if (previous && isBlank(source.slice(previous.end, comment.start))) {
      previous.end = comment.end;
      previous.comments.push(comment);
      continue;
    }
    spans.push({ start: comment.start, end: comment.end, comments: [comment] });
  }

  return spans;
}

/**
 * 删除 CSS 注释，返回删除后的源码与删除/保留明细。
 *
 * 位于被删注释内部的偏移不会被输出，其余内容逐字保留（含原有缩进与空行），
 * 因此同一份源码重复调用不会再产生变化（幂等）；保留的注释也会原样出现在结果里。
 */
export function removeCssComments(source: string, options: RemoveCssCommentsOptions = {}): CssCommentRemoval {
  const comments = findCssComments(source);
  const kept: CssComment[] = [];
  const removed: CssComment[] = [];

  for (const comment of comments) {
    (options.keep?.(comment) ? kept : removed).push(comment);
  }

  if (removed.length === 0) return { output: source, removed, kept };

  const spans = mergeAdjacentComments(source, removed);
  let output = "";
  let cursor = 0;

  for (const span of spans) {
    // 独行注释：连同所在行的行首缩进与行尾换行一起删除，不留空白行。
    // 跨行注释块同理——lineStart 是注释起点所在行的行首，lineEnd 是注释终点所在行的行尾。
    const lineStart = source.lastIndexOf("\n", span.start - 1) + 1;
    const nextLineBreak = source.indexOf("\n", span.end);
    const lineEnd = nextLineBreak === -1 ? source.length : nextLineBreak;

    if (isBlank(source.slice(lineStart, span.start)) && isBlank(source.slice(span.end, lineEnd))) {
      // 前面紧邻空行时一并吸收：独行注释块多是章节说明，删掉后不该在原文的空行之外再留空行。
      const previousLineStart = lineStart === 0 ? 0 : source.lastIndexOf("\n", lineStart - 2) + 1;
      const absorbPreviousBlankLine = lineStart > 0 && isBlank(source.slice(previousLineStart, lineStart - 1));

      output += source.slice(cursor, absorbPreviousBlankLine ? previousLineStart : lineStart);
      cursor = Math.min(lineEnd + 1, source.length);
      continue;
    }

    output += source.slice(cursor, span.start);

    // 行内注释：两侧都紧邻非空白字符时补一个空格，维持原 token 边界。
    const left = span.start > 0 ? (source[span.start - 1] as string) : "";
    const right = span.end < source.length ? (source[span.end] as string) : "";
    if (left !== "" && right !== "" && !isCssWhitespace(left) && !isCssWhitespace(right)) {
      output += " ";
    }

    cursor = span.end;
  }

  output += source.slice(cursor);
  return { output, removed, kept };
}

/**
 * 注释两侧是否都紧邻非空白字符。
 *
 * 这类注释删除后可能粘连两侧 token（见文件头第 3 条的两难），扫描报告据此提示人工复核；
 * 本仓现有样式表中无此类实例，它主要防的是「值内用注释分词」的写法。
 */
export function isTightlyEmbeddedComment(source: string, comment: CssComment): boolean {
  const left = comment.start > 0 ? (source[comment.start - 1] as string) : "";
  const right = comment.end < source.length ? (source[comment.end] as string) : "";
  return left !== "" && right !== "" && !isCssWhitespace(left) && !isCssWhitespace(right);
}

/** 注释摘要：取注释内容首行并压平空白，供扫描报告单行展示。 */
export function summarizeCssComment(comment: CssComment): string {
  const body = comment.text.replace(/^\/\*+/, "").replace(/\*\/$/, "");
  const firstLine = body
    .split("\n")
    .map((line) => line.replace(/^\s*\*?\s*/, "").trim())
    .find((line) => line !== "");

  const summary = firstLine ?? "";
  return summary.length > 80 ? `${summary.slice(0, 79)}…` : summary;
}
