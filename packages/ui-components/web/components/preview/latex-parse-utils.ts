/**
 * LaTeX 文本扫描的底层工具：游标、花括号分组、可选参数、注释与环境标记。
 *
 * `latex-inline.ts`（行内）与 `latex-document.ts`（块级）共用这一份口径，避免两处各写一套
 * 括号匹配——两套实现的差异会直接表现为「某些文档能解析、某些不能」。
 */

/** 扫描游标：`text` 为不可变输入，`index` 是当前读取位置。 */
export interface LatexCursor {
  text: string;
  index: number;
}

export function createCursor(text: string): LatexCursor {
  return { text, index: 0 };
}

export function matchesAt(cursor: LatexCursor, token: string): boolean {
  return cursor.text.startsWith(token, cursor.index);
}

export function atEnd(cursor: LatexCursor): boolean {
  return cursor.index >= cursor.text.length;
}

export function skipSpaces(cursor: LatexCursor): void {
  while (cursor.index < cursor.text.length && /\s/.test(cursor.text[cursor.index] ?? "")) cursor.index += 1;
}

/** 读命令名（字母序列，含可选的 `*` 变体后缀），并把游标移到命令名之后。 */
export function readCommandName(cursor: LatexCursor): string {
  const start = cursor.index;
  let index = cursor.index;
  while (index < cursor.text.length && /[A-Za-z]/.test(cursor.text[index] ?? "")) index += 1;
  if (cursor.text[index] === "*") index += 1;
  cursor.index = index;
  return cursor.text.slice(start, index);
}

/** 只窥探 `index` 处的命令名，不移动游标（块级主循环做判定用）。 */
export function peekCommandName(text: string, index: number): string | null {
  if (text[index] !== "\\") return null;
  const match = /^\\[A-Za-z]+\*?/.exec(text.slice(index));
  return match ? match[0].slice(1) : null;
}

/** 定位 `{`（`openIndex`）对应的 `}`，跳过转义字符与嵌套层；不匹配时返回 `-1`。 */
export function findGroupEnd(text: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** 读 `{...}` 参数（返回花括号内的原始 LaTeX）；没有花括号参数时返回 `null`，游标只前进过空白。 */
export function readGroupArgument(cursor: LatexCursor): string | null {
  skipSpaces(cursor);
  if (cursor.text[cursor.index] !== "{") return null;
  const end = findGroupEnd(cursor.text, cursor.index);
  if (end === -1) {
    cursor.index = cursor.text.length;
    return null;
  }
  const value = cursor.text.slice(cursor.index + 1, end);
  cursor.index = end + 1;
  return value;
}

/** 读 `[...]` 可选参数；未命中时返回 `null` 且游标原地不动。 */
export function readOptionalArgument(cursor: LatexCursor): string | null {
  const saved = cursor.index;
  skipSpaces(cursor);
  if (cursor.text[cursor.index] !== "[") {
    cursor.index = saved;
    return null;
  }
  const end = cursor.text.indexOf("]", cursor.index);
  if (end === -1) {
    cursor.index = saved;
    return null;
  }
  const value = cursor.text.slice(cursor.index + 1, end);
  cursor.index = end + 1;
  return value;
}

/**
 * 跳过 `%` 注释段。**保留行尾换行**：LaTeX 里注释会吃掉换行，但预览只关心段落划分，
 * 吃掉换行会把注释前后的两行粘成一段，反而与用户看到的源文件不一致。
 */
export function skipComment(cursor: LatexCursor): boolean {
  if (cursor.text[cursor.index] !== "%") return false;
  const lineEnd = cursor.text.indexOf("\n", cursor.index);
  cursor.index = lineEnd === -1 ? cursor.text.length : lineEnd;
  return true;
}

/** 跳空白与注释；返回是否跨过了空行（调用方据此断段）。 */
export function skipWhitespaceAndComments(cursor: LatexCursor): boolean {
  let sawBlankLine = false;
  while (cursor.index < cursor.text.length) {
    const char = cursor.text[cursor.index] ?? "";
    if (char === "\n") {
      if (isBlankLineAt(cursor.text, cursor.index)) sawBlankLine = true;
      cursor.index += 1;
      continue;
    }
    if (/\s/.test(char)) {
      cursor.index += 1;
      continue;
    }
    if (skipComment(cursor)) continue;
    break;
  }
  return sawBlankLine;
}

/** 从 `index` 起是否为空行（`\n` + 可选空白 + `\n`）。 */
export function isBlankLineAt(text: string, index: number): boolean {
  if (text[index] !== "\n") return false;
  return /^\n\s*\n/.test(text.slice(index));
}

/** `index` 处的字符是否被反斜杠转义（区分 `\\%` 与 `\%`）。 */
export function isEscapedAt(text: string, index: number): boolean {
  let backslashes = 0;
  let probe = index - 1;
  while (probe >= 0 && text[probe] === "\\") {
    backslashes += 1;
    probe -= 1;
  }
  return backslashes % 2 === 1;
}

/** 读 `\begin{name}` / `\end{name}`；命中时消费并返回环境名，否则游标不动返回 `null`。 */
export function readEnvironmentMarker(cursor: LatexCursor, keyword: "begin" | "end"): string | null {
  const marker = `\\${keyword}`;
  if (!matchesAt(cursor, marker)) return null;
  const saved = cursor.index;
  cursor.index += marker.length;
  skipSpaces(cursor);
  if (cursor.text[cursor.index] !== "{") {
    cursor.index = saved;
    return null;
  }
  const end = cursor.text.indexOf("}", cursor.index);
  if (end === -1) {
    cursor.index = saved;
    return null;
  }
  const name = cursor.text.slice(cursor.index + 1, end);
  cursor.index = end + 1;
  return name;
}

/**
 * 读到指定环境的 `\end{}` 之前的原始正文（数学、表格、逐字环境用）。
 * 缺结束标记时读到文末——截断的文档只该少内容，不该让预览卡在半途。
 */
export function readUntilEnvironmentEnd(cursor: LatexCursor, environment: string): string {
  const marker = `\\end{${environment}}`;
  const end = cursor.text.indexOf(marker, cursor.index);
  if (end === -1) {
    const rest = cursor.text.slice(cursor.index);
    cursor.index = cursor.text.length;
    return rest;
  }
  const raw = cursor.text.slice(cursor.index, end);
  cursor.index = end + marker.length;
  return raw;
}

/** 读到分隔符之前（`\]` / `$$`），分隔符本身被消费。 */
export function readUntilDelimiter(cursor: LatexCursor, delimiter: string): string {
  const end = cursor.text.indexOf(delimiter, cursor.index);
  if (end === -1) {
    const rest = cursor.text.slice(cursor.index);
    cursor.index = cursor.text.length;
    return rest;
  }
  const raw = cursor.text.slice(cursor.index, end);
  cursor.index = end + delimiter.length;
  return raw;
}
