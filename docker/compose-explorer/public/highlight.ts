/**
 * 文件视图的逐行着色。
 *
 * 目的是「看得出结构」而不是完整语法分析：只标出注释、键名、字符串与环境变量插值，
 * 且先转义再拼 HTML。宁可漏标也不能标错到破坏可读性。
 */

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const COMMENT_LANGS = new Set(["yaml", "toml", "shell", "python"]);
const KEY_PATTERN = /^(\s*)((?:[\w.\-]+|"[^"]*"|'[^']*')(?:\s*|(?=\s)))(:)(\s*)(.*)$/;

/** 找出注释起点：引号外的第一个 `#`（前面必须是行首或空白）。 */
function splitComment(line: string, language: string): { code: string; comment: string } {
  if (!COMMENT_LANGS.has(language)) return { code: line, comment: "" };
  let quote: string | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === quote && line[index - 1] !== "\\") quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#" && (index === 0 || /\s/.test(line[index - 1]))) {
      return { code: line.slice(0, index), comment: line.slice(index) };
    }
  }
  return { code: line, comment: "" };
}

/** 值部分：字符串与环境变量插值。 */
function highlightValue(value: string): string {
  const pattern = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\$\{[^}]*\})/g;
  let result = "";
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0;
    result += escapeHtml(value.slice(cursor, index));
    result += match[1]
      ? `<span class="tok-str">${escapeHtml(match[1])}</span>`
      : `<span class="tok-var">${escapeHtml(match[2])}</span>`;
    cursor = index + match[0].length;
  }
  return result + escapeHtml(value.slice(cursor));
}

export function highlightLine(line: string, language: string): string {
  const { code, comment } = splitComment(line, language);
  const suffix = comment ? `<span class="tok-comment">${escapeHtml(comment)}</span>` : "";

  if (language === "yaml" || language === "toml") {
    const match = KEY_PATTERN.exec(code);
    if (match) {
      const [, indent, key, colon, spacing, value] = match;
      return `${escapeHtml(indent)}<span class="tok-key">${escapeHtml(key)}</span>${escapeHtml(colon + spacing)}${highlightValue(value)}${suffix}`;
    }
  }
  return highlightValue(code) + suffix;
}
