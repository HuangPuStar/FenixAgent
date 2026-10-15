/**
 * LaTeX 文档结构解析：把 `.tex` 正文切成「常见文档结构 + 公式」的块序列，交给 `latex-content.tsx` 渲染。
 *
 * **为什么自己解析**：预览要的不是 LaTeX 排版还原（那需要完整 TeX 引擎），而是「文档长什么样」——
 * 章节层级、段落、列表、公式、表格、逐字环境。KaTeX 只吃数学模式，`\section` 之类正文结构不在它的
 * 范围内；仓库里也没有第二个 LaTeX 解析器可复用，因此只维护这一份结构化口径。
 *
 * 边界（刻意不做的部分）：不展开宏定义、不做交叉引用编号、不还原字体与浮动体位置、不处理
 * `\input` / `\include`。未知环境按「透传内部块」处理，未知命令按「丢宏名、留正文」处理
 * （见 `latex-inline.ts`），保证内容不会因为不认识某个写法而整段消失。
 */

import { isDroppedLatexCommand, type LatexInline, parseLatexInline, skipLatexCommand } from "./latex-inline";
import {
  createCursor,
  findGroupEnd,
  isBlankLineAt,
  isEscapedAt,
  type LatexCursor,
  matchesAt,
  peekCommandName,
  readEnvironmentMarker,
  readGroupArgument,
  readOptionalArgument,
  readUntilDelimiter,
  readUntilEnvironmentEnd,
  skipComment,
  skipWhitespaceAndComments,
} from "./latex-parse-utils";

export type { LatexInline } from "./latex-inline";

/** 块节点。 */
export type LatexBlock =
  | { kind: "title"; title: LatexInline[]; author: LatexInline[]; date: LatexInline[] }
  | { kind: "heading"; level: number; children: LatexInline[] }
  | { kind: "paragraph"; children: LatexInline[] }
  | { kind: "displayMath"; source: string }
  | { kind: "list"; ordered: boolean; items: LatexBlock[][] }
  | { kind: "table"; rows: LatexInline[][][] }
  | { kind: "verbatim"; text: string }
  | { kind: "quote"; blocks: LatexBlock[] };

/** 解析结果：文档元信息（来自导言区的 `\title` / `\author` / `\date`）与块序列。 */
export interface LatexDocument {
  title: LatexInline[];
  author: LatexInline[];
  date: LatexInline[];
  blocks: LatexBlock[];
}

/** 章节命令 → 标题层级（`\part` / `\chapter` 合并为一级标题）。 */
const HEADING_LEVELS: Record<string, number> = {
  part: 1,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
};

const VERBATIM_ENVIRONMENTS = new Set(["verbatim", "Verbatim", "lstlisting", "minted", "alltt"]);

/**
 * 数学环境：整段按原文交给 KaTeX（`displayMode` 由渲染层按块决定）。
 * 列表里有 KaTeX 不支持的（如 `eqnarray`）：那时 KaTeX 走错误态渲染，预览仍是活的。
 */
const MATH_ENVIRONMENTS = new Set([
  "equation",
  "equation*",
  "displaymath",
  "align",
  "align*",
  "alignat",
  "alignat*",
  "flalign",
  "flalign*",
  "gather",
  "gather*",
  "multline",
  "multline*",
  "dmath",
  "dmath*",
]);

const LIST_ENVIRONMENTS: Record<string, boolean> = {
  itemize: false,
  "itemize*": false,
  enumerate: true,
  "enumerate*": true,
  description: false,
};

const TABLE_ENVIRONMENTS = new Set(["tabular", "tabular*", "tabularx", "longtable", "array"]);

/** 以引用块呈现的环境；浮动体与定理类环境的内容同样是正文，缩进呈现即可。 */
const QUOTE_ENVIRONMENTS = new Set([
  "abstract",
  "quote",
  "quotation",
  "center",
  "flushleft",
  "flushright",
  "figure",
  "figure*",
  "table",
  "table*",
  "theorem",
  "lemma",
  "proposition",
  "corollary",
  "definition",
  "proof",
  "remark",
  "example",
]);

interface BlockScanOptions {
  /** 遇到该环境的 `\end{}` 时停下；`null` 表示读到文末。 */
  stopEnvironment: string | null;
  /** 列表项内扫描：遇到同级 `\item` 停下（不消费）。 */
  stopAtItem: boolean;
  /**
   * 停下时是否连带消费 `\end{}`。
   *
   * 列表项内部必须为 `false`：结束标记要留给**列表循环**处理（它靠 `\end{列表}` 判断收尾）。
   * 若在项内就被吃掉，列表循环会一路扫到文末，把后面所有章节吞进最后一项——2026-10-15 实测到的
   * 「首个列表之后整篇消失」正是这个原因。
   */
  consumeStopMarker: boolean;
}

/**
 * 解析 `.tex` 正文。
 *
 * 标题块（`\title` / `\author` / `\date`）统一插在块序列最前面，而不是等 `\maketitle` 的位置：
 * LLM 产出的 `.tex` 常常只写元信息不写 `\maketitle`，按位置还原会让预览顶部缺掉标题。
 */
export function parseLatexDocument(source: string): LatexDocument {
  const metadata = readMetadata(source);
  const cursor = createCursor(extractBody(source));
  const blocks = readBlocks(cursor, { stopEnvironment: null, stopAtItem: false, consumeStopMarker: true });
  const hasMetadata = metadata.title.length > 0 || metadata.author.length > 0 || metadata.date.length > 0;
  if (hasMetadata) blocks.unshift({ kind: "title", ...metadata });
  return { ...metadata, blocks };
}

/**
 * 读导言区命令 `\title` / `\author` / `\date`。
 *
 * 整篇扫描而非只看 `\begin{document}` 之前：同名命令以最后一次为准，正文里重写的元信息因此生效。
 */
function readMetadata(source: string): Pick<LatexDocument, "title" | "author" | "date"> {
  const read = (command: string): LatexInline[] => {
    const pattern = new RegExp(`\\\\${command}\\s*(?:\\[[^\\]]*\\])?\\s*\\{`, "g");
    let result: LatexInline[] = [];
    for (const match of source.matchAll(pattern)) {
      const openIndex = (match.index ?? 0) + match[0].length - 1;
      const end = findGroupEnd(source, openIndex);
      if (end === -1) continue;
      result = parseLatexInline(source.slice(openIndex + 1, end));
    }
    return result;
  };
  return { title: read("title"), author: read("author"), date: read("date") };
}

/** 已消费 `\begin{document}` 之后的正文；没有该命令时整篇都是正文（片段式 `.tex` 很常见）。 */
function extractBody(source: string): string {
  const marker = /\\begin\s*\{document\}/.exec(source);
  if (!marker) return source;
  return source.slice((marker.index ?? 0) + marker[0].length);
}

function readBlocks(cursor: LatexCursor, options: BlockScanOptions): LatexBlock[] {
  const blocks: LatexBlock[] = [];
  while (cursor.index < cursor.text.length) {
    skipWhitespaceAndComments(cursor);
    if (cursor.index >= cursor.text.length) break;
    if (options.stopAtItem && matchesAt(cursor, "\\item")) break;

    const markerStart = cursor.index;
    const environmentEnd = readEnvironmentMarker(cursor, "end");
    if (environmentEnd !== null) {
      if (options.stopEnvironment === environmentEnd) {
        if (!options.consumeStopMarker) cursor.index = markerStart;
        break;
      }
      continue; // 孤立的 \end：忽略
    }

    const environmentStart = readEnvironmentMarker(cursor, "begin");
    if (environmentStart !== null) {
      blocks.push(...readEnvironmentBlocks(cursor, environmentStart));
      continue;
    }

    if (matchesAt(cursor, "\\[")) {
      cursor.index += 2;
      blocks.push({ kind: "displayMath", source: readUntilDelimiter(cursor, "\\]") });
      continue;
    }
    if (matchesAt(cursor, "$$")) {
      cursor.index += 2;
      blocks.push({ kind: "displayMath", source: readUntilDelimiter(cursor, "$$") });
      continue;
    }

    const command = peekCommandName(cursor.text, cursor.index);
    if (command !== null) {
      const name = baseCommandName(command);
      if (name in HEADING_LEVELS) {
        cursor.index += command.length + 1;
        readOptionalArgument(cursor);
        const argument = readGroupArgument(cursor) ?? "";
        blocks.push({ kind: "heading", level: HEADING_LEVELS[name] ?? 2, children: parseLatexInline(argument) });
        continue;
      }
      if (name === "maketitle") {
        cursor.index += command.length + 1;
        continue; // 标题块由 parseLatexDocument 统一插入
      }
      if (isDroppedLatexCommand(name)) {
        cursor.index += command.length + 1;
        skipLatexCommand(cursor, name);
        continue;
      }
    }

    const paragraph = readParagraphText(cursor, options).trim();
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", children: parseLatexInline(paragraph) });
    else cursor.index += 1; // 兜底前进，避免死循环
  }
  return blocks;
}

/** 环境名 → 块；无法归类时透传其内部块。 */
function readEnvironmentBlocks(cursor: LatexCursor, name: string): LatexBlock[] {
  if (MATH_ENVIRONMENTS.has(name)) {
    const body = readUntilEnvironmentEnd(cursor, name);
    return [{ kind: "displayMath", source: `\\begin{${name}}${body}\\end{${name}}` }];
  }
  if (VERBATIM_ENVIRONMENTS.has(name)) {
    return [{ kind: "verbatim", text: readUntilEnvironmentEnd(cursor, name) }];
  }
  if (name in LIST_ENVIRONMENTS) {
    const list = readListEnvironment(cursor, name, LIST_ENVIRONMENTS[name] === true);
    return list ? [list] : [];
  }
  if (TABLE_ENVIRONMENTS.has(name)) {
    const rows = parseTableBody(readUntilEnvironmentEnd(cursor, name));
    return rows.length > 0 ? [{ kind: "table", rows }] : [];
  }
  // 含 `\begin{document}` 的完整文档：正文本身不需要外层包装
  const inner = readBlocks(cursor, { stopEnvironment: name, stopAtItem: false, consumeStopMarker: true });
  if (name === "document") return inner;
  if (QUOTE_ENVIRONMENTS.has(name)) return [{ kind: "quote", blocks: inner }];
  return inner;
}

/** 列表环境：逐项读 `\item`，每项内容是**块序列**，嵌套列表因此可以自然递归。 */
function readListEnvironment(cursor: LatexCursor, name: string, ordered: boolean): LatexBlock | null {
  const items: LatexBlock[][] = [];
  while (cursor.index < cursor.text.length) {
    skipWhitespaceAndComments(cursor);
    if (readEnvironmentMarker(cursor, "end") === name) break;
    if (matchesAt(cursor, "\\item")) {
      cursor.index += "\\item".length;
      const label = readOptionalArgument(cursor);
      const itemBlocks = readBlocks(cursor, { stopEnvironment: name, stopAtItem: true, consumeStopMarker: false });
      if (label !== null && label.trim().length > 0) {
        itemBlocks.unshift({ kind: "paragraph", children: [{ kind: "strong", children: parseLatexInline(label) }] });
      }
      items.push(itemBlocks);
      continue;
    }
    cursor.index += 1; // `\item` 之前的杂项内容（如 `\setlength`），跳过避免死循环
  }
  return items.length > 0 ? { kind: "list", ordered, items } : null;
}

/** 表格正文 → 行 → 单元格。只处理 `&` 分列与 `\\` 分行，列格式与横线丢弃。 */
function parseTableBody(raw: string): LatexInline[][][] {
  const body = raw
    .replace(/^\s*\{[^{}]*\}/, "")
    .replace(/\\(?:hline|toprule|midrule|bottomrule|hdashline|cline\{[^}]*\})/g, "")
    // 行的换行间距写作 `\\[2pt]`，与行分隔符同源，先并回行分隔符
    .replace(/\\\\\s*\[[^\]]*\]/g, "\\\\");
  return body
    .split("\\\\")
    .map((row) => row.trim())
    .filter((row) => row.length > 0)
    .map((row) => row.split("&").map((cell) => parseLatexInline(cell.trim())));
}

/**
 * 段落文本：读到块级边界或空行为止。
 *
 * 返回的是**原始 LaTeX**（注释已剔除），行内解析交给 `parseLatexInline`：段落边界由块级解析判定，
 * 行内结构由行内解析处理，两者只在此处交接一次。
 *
 * 逐段拼接而不是整段切片：注释要从中剔除，切片无法跳过中间片段（`start..index` 是连续区间），
 * 会把 `% 注释` 原样带进渲染结果。
 */
function readParagraphText(cursor: LatexCursor, options: BlockScanOptions): string {
  const parts: string[] = [];
  let chunkStart = cursor.index;
  let index = cursor.index;
  while (index < cursor.text.length) {
    if (cursor.text[index] === "\n" && isBlankLineAt(cursor.text, index)) break;
    if (isBlockBoundaryAt(cursor.text, index, options)) break;
    if (cursor.text[index] === "%" && !isEscapedAt(cursor.text, index)) {
      parts.push(cursor.text.slice(chunkStart, index));
      const probe: LatexCursor = { text: cursor.text, index };
      skipComment(probe);
      index = probe.index;
      chunkStart = index;
      continue;
    }
    index += 1;
  }
  parts.push(cursor.text.slice(chunkStart, index));
  cursor.index = index;
  return parts.join("");
}

/** 带星号的变体与本体同义（`\section*` 只是无编号），结构性判定按本体进行。 */
function baseCommandName(command: string): string {
  return command.endsWith("*") ? command.slice(0, -1) : command;
}

/** 该位置是否是块级边界：段落读到这里就收尾，交由主循环处理。 */
function isBlockBoundaryAt(text: string, index: number, options: BlockScanOptions): boolean {
  if (text.startsWith("\\begin{", index) || text.startsWith("\\end{", index)) return true;
  if (options.stopAtItem && text.startsWith("\\item", index)) return true;
  if (text.startsWith("\\[", index) || text.startsWith("$$", index)) return true;
  const command = peekCommandName(text, index);
  if (command === null) return false;
  const name = baseCommandName(command);
  if (name in HEADING_LEVELS) return true;
  if (name === "maketitle") return true;
  return isDroppedLatexCommand(name);
}
