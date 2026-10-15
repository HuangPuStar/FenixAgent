/**
 * LaTeX 行内解析：把一段正文（段落、标题、列表项等）切成行内节点 —— 文本、公式与少量字符级样式。
 *
 * 与块级解析（`latex-document.ts`）的分工：块级只负责「哪些内容属于哪一块」，块内的字符处理全在这里。
 *
 * 设计口径：
 * 1. **未知识别为「丢宏名、留正文」**：不认识 `\foo{正文}` 时保留 `正文`，只丢宏名。宁可少一段样式，
 *    也不能因为不认识某个宏就让作者写的内容消失。
 * 2. **公式原样保留**：`$…$` / `$$…$$` / `\(…\)` / `\[…\]` 的内容按原文交给 KaTeX，这里不做任何
 *    化简——KaTeX 认得的命令远多于本模块，转手越多越容易把能渲染的公式改坏。
 * 3. **不做编号**：`\ref` / `\cite` 没有编号机制可依（这里没有编译计数），按 `[键]` 呈现，
 *    至少让读者知道此处存在一个引用。
 */

import {
  atEnd,
  createCursor,
  findGroupEnd,
  type LatexCursor,
  readCommandName,
  readGroupArgument,
  readOptionalArgument,
  skipSpaces,
} from "./latex-parse-utils";

/** 行内节点：文本、公式与字符级样式。 */
export type LatexInline =
  | { kind: "text"; value: string }
  /** `source` 是原始 LaTeX（含环境写法），交给 KaTeX；渲染失败时由渲染层回退源码。 */
  | { kind: "math"; source: string; display: boolean }
  | { kind: "strong"; children: LatexInline[] }
  | { kind: "emphasis"; children: LatexInline[] }
  | { kind: "code"; children: LatexInline[] }
  /** `\\` 或 `\newline`。 */
  | { kind: "lineBreak" };

/** 带一个参数的字符级样式命令。开关式写法（`{\bfseries x}`）走到这里时无参数，宏名被丢、正文保留。 */
const STYLE_COMMANDS: Record<string, "strong" | "emphasis" | "code"> = {
  textbf: "strong",
  bfseries: "strong",
  emph: "emphasis",
  textit: "emphasis",
  textsl: "emphasis",
  texttt: "code",
  bf: "strong",
  it: "emphasis",
  tt: "code",
};

/** 引用 / 交叉引用：无编号可还原，按 `[键]` 显示。 */
const REFERENCE_COMMANDS = new Set(["ref", "eqref", "pageref", "autoref", "cref", "Cref", "cite", "citep", "citet"]);

/** 有固定可见字形、值得保留的符号命令。 */
const SYMBOL_COMMANDS: Record<string, string> = {
  LaTeX: "LaTeX",
  TeX: "TeX",
  ldots: "…",
  dots: "…",
  textbackslash: "\\",
  textasciitilde: "~",
  textbar: "|",
  copyright: "©",
  dag: "†",
  S: "§",
  P: "¶",
  // `\author{A \and B}` 的分隔宏：丢掉会让两个作者名粘在一起
  and: ", ",
};

/** 反斜杠后可直接还原成字符的标点。 */
const ESCAPED_CHARACTERS = new Set(["%", "&", "_", "#", "$", "{", "}", "@", "~", "^"]);

/** 零参数的排版开关：只影响排版，正文里遇到就丢命令名。 */
const DROPPED_SWITCH_COMMANDS = new Set([
  "hline",
  "noindent",
  "centering",
  "tableofcontents",
  "listoffigures",
  "listoftables",
  "newpage",
  "clearpage",
  "pagebreak",
  "linebreak",
  "smallskip",
  "medskip",
  "bigskip",
  "printbibliography",
]);

/** 带参数的排版 / 配置命令：连同参数一起丢，避免参数正文漏成可见文本。 */
const DROPPED_ARGUMENT_COMMANDS = new Set([
  "label",
  "index",
  "vspace",
  "hspace",
  "vskip",
  "hskip",
  "setcounter",
  "addtocounter",
  "setlength",
  "addtolength",
  "pagestyle",
  "thispagestyle",
  "includegraphics",
  "bibliography",
  "bibliographystyle",
  "documentclass",
  "usepackage",
  "newcommand",
  "renewcommand",
  "providecommand",
  "graphicspath",
  "geometry",
  "hypersetup",
  "definecolor",
  "cline",
]);

/**
 * 丢掉一个排版命令及其参数（调用时游标应在命令名之后）。
 *
 * 参数按「可选 `[...]` + 连续的 `{...}`（最多 3 个）」贪心消费：这些命令的写法覆盖面（
 * `\includegraphics[width=…]{…}`、`\newcommand{\x}[1]{…}`、`\setcounter{a}{b}`）都在这个范围内，
 * 而它们后面紧跟的同级 `{...}` 分组在实践中不存在。零参数开关走 `DROPPED_SWITCH_COMMANDS`，
 * 不消费任何参数——否则 `\noindent {正文}` 会被整组吃掉。
 */
export function skipLatexCommand(cursor: LatexCursor, command: string): void {
  if (DROPPED_SWITCH_COMMANDS.has(command)) return;
  readOptionalArgument(cursor);
  for (let index = 0; index < 3; index += 1) {
    if (readGroupArgument(cursor) === null) break;
  }
}

/** 该命令是否属于「只影响排版」的一类（块级解析据此判定段落边界）。 */
export function isDroppedLatexCommand(command: string): boolean {
  return DROPPED_SWITCH_COMMANDS.has(command) || DROPPED_ARGUMENT_COMMANDS.has(command);
}

/** 行内解析入口。 */
export function parseLatexInline(text: string): LatexInline[] {
  return readInline(createCursor(text), false);
}

/** 取行内节点里的纯文字（引用键、脚注这类只需要文本的场景）。 */
export function flattenLatexInline(nodes: LatexInline[]): string {
  return nodes
    .map((node) => {
      if (node.kind === "text") return node.value;
      if (node.kind === "lineBreak") return " ";
      if (node.kind === "math") return node.source;
      return flattenLatexInline(node.children);
    })
    .join("");
}

function readInline(cursor: LatexCursor, insideGroup: boolean): LatexInline[] {
  const nodes: LatexInline[] = [];
  let buffer = "";

  const flush = () => {
    if (buffer.length === 0) return;
    nodes.push({ kind: "text", value: buffer });
    buffer = "";
  };

  while (!atEnd(cursor)) {
    const char = cursor.text[cursor.index] ?? "";

    if (char === "}" && insideGroup) {
      cursor.index += 1;
      break;
    }

    if (char === "{") {
      const end = findGroupEnd(cursor.text, cursor.index);
      if (end === -1) {
        cursor.index += 1;
        continue;
      }
      // 分组只承载作用域，预览里直接并入当前层级
      const inner = readInline(createCursor(cursor.text.slice(cursor.index + 1, end)), false);
      flush();
      nodes.push(...inner);
      cursor.index = end + 1;
      continue;
    }

    if (char === "$") {
      const display = cursor.text.startsWith("$$", cursor.index);
      const delimiter = display ? "$$" : "$";
      const from = cursor.index + delimiter.length;
      const end = findInlineMathEnd(cursor.text, from, delimiter);
      if (end !== -1) {
        flush();
        nodes.push({ kind: "math", source: cursor.text.slice(from, end), display });
        cursor.index = end + delimiter.length;
        continue;
      }
      // 找不到配对定界符：按普通字符处理，避免把后面的正文整段吞进公式
      buffer += char;
      cursor.index += 1;
      continue;
    }

    if (char === "\\") {
      cursor.index += 1;
      const next = cursor.text[cursor.index] ?? "";

      if (next === "\\" || next === "\n") {
        cursor.index += 1;
        flush();
        nodes.push({ kind: "lineBreak" });
        continue;
      }
      if (ESCAPED_CHARACTERS.has(next)) {
        buffer += next;
        cursor.index += 1;
        continue;
      }
      if (next === "(" || next === "[") {
        const delimiter = next === "(" ? "\\)" : "\\]";
        const from = cursor.index + 1;
        const end = cursor.text.indexOf(delimiter, from);
        if (end !== -1) {
          flush();
          nodes.push({ kind: "math", source: cursor.text.slice(from, end), display: next === "[" });
          cursor.index = end + delimiter.length;
          continue;
        }
        cursor.index += 1;
        continue;
      }
      // `\ `、`\,`、`\;`、`\!` 之类的间距命令
      if (/[\s,;:!]/.test(next)) {
        buffer += " ";
        cursor.index += 1;
        continue;
      }

      const name = readCommandName(cursor);
      const symbol = SYMBOL_COMMANDS[name];
      if (symbol !== undefined) {
        buffer += symbol;
        continue;
      }

      const style = STYLE_COMMANDS[name];
      if (style) {
        readOptionalArgument(cursor);
        const argument = readGroupArgument(cursor);
        if (argument === null) continue;
        flush();
        nodes.push({ kind: style, children: parseLatexInline(argument) });
        continue;
      }

      if (REFERENCE_COMMANDS.has(name)) {
        const argument = readGroupArgument(cursor);
        if (argument !== null) buffer += `[${flattenLatexInline(parseLatexInline(argument)).trim()}]`;
        continue;
      }

      if (name === "footnote") {
        const argument = readGroupArgument(cursor);
        if (argument !== null) buffer += ` (${flattenLatexInline(parseLatexInline(argument)).trim()})`;
        continue;
      }

      if (name === "multicolumn") {
        // `\multicolumn{列数}{列格式}{正文}`：只保留正文
        skipSpaces(cursor);
        readGroupArgument(cursor);
        readGroupArgument(cursor);
        const argument = readGroupArgument(cursor);
        if (argument !== null) {
          flush();
          nodes.push(...parseLatexInline(argument));
        }
        continue;
      }

      if (isDroppedLatexCommand(name)) {
        skipLatexCommand(cursor, name);
        continue;
      }

      // 未知命令：丢宏名、留参数正文
      readOptionalArgument(cursor);
      const argument = readGroupArgument(cursor);
      if (argument !== null) {
        flush();
        nodes.push(...parseLatexInline(argument));
      }
      continue;
    }

    if (char === "~") {
      buffer += " ";
      cursor.index += 1;
      continue;
    }

    buffer += char;
    cursor.index += 1;
  }

  flush();
  return nodes;
}

/**
 * 找行内公式的收尾定界符。
 *
 * 跳过 `\$` 转义，并要求收尾定界符前一个字符不是空白：`.tex` 正文里的 `$` 没有货币含义，
 * 但 `$100 元 $200` 这类文本仍会误导配对——收紧一点，宁可不成对（按普通字符处理）也不要匹配错位置。
 */
function findInlineMathEnd(text: string, from: number, delimiter: string): number {
  let index = from;
  while (index < text.length) {
    if (text[index] === "\\") {
      index += 2;
      continue;
    }
    if (index > from && text.startsWith(delimiter, index) && !/\s/.test(text[index - 1] ?? "")) return index;
    index += 1;
  }
  return -1;
}
