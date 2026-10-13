/**
 * `FCP-WEB-07/08` 的检测核心：伴随表（`.css`）声明值里的长度 / 颜色字面量。
 *
 * 与 `web-style-rules.ts`（扫 className 里的字符串字面量）是两种输入，规则同由
 * `docs/developer/guide/forbidden-code-patterns.md` 定义。本模块只负责「从一段 CSS 里找出命中的字面量」：
 * 不判断文件是否属于伴随表、不遍历目录、不读台账——「哪些 `.css` 要扫」是门禁入口
 * （`check-web-style.ts`）的职责。
 *
 * 口径：
 * - 只扫**声明值**。选择器、`@media` / `@supports` / `@container` 预lude（断点本来就以 px / rem 书写、
 *   且属规范允许的「无标准变体的媒体块」）、`@import` 一类无块 at-rule、注释与引号字符串都不进判定。
 * - 长度：`数字 + px/rem`。零值（`0px` / `0rem`）不报——零不是设计取值，写成 token 形态反而更难读。
 * - 颜色：`#hex` 与颜色函数。**透明色**（`#0000`、`#00000000`）不报——Tailwind 的
 *   `var(--tw-ring-offset-shadow, 0 0 #0000)` 一类管道值在各表里遍地都是，报了只会淹没真实命中。
 *
 * 已知取舍：
 * - 位置按 UTF-16 偏移计算，掩码（注释 / 引号）用等长空白替换，行号列号不漂移；
 *   本门禁用于定位与排期，不追求能直接用于编辑。
 * - 不做值级语义分析：`var(--tw-shadow-color, rgb(…))` 的 fallback 里出现颜色字面量同样报——
 *   它确实是写死的取值，改法是换成 token 或改由工具类承担。
 */

import type { WebStyleRuleId, WebStyleViolation } from "./web-style-rules";

/** 长度字面量：`12px`、`1.5rem`；左邻不能是标识符字符，避免从 `--x-12px` 之类的尾部起匹配。 */
const LENGTH_LITERAL = /(?<![\w.])(\d+(?:\.\d+)?)(?:px|rem)\b/g;
/** 颜色字面量：`#e0e7f0`，含 3 / 4 / 6 / 8 位的简写与带 alpha 形态。 */
const HEX_COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b/g;
/** 颜色函数：本仓在用的 `rgb()` / `hsl()` / `oklch()` 一族；`color-mix(` 不在此列（`(` 必须紧跟 `color`）。 */
const COLOR_FUNCTION_LITERAL = /\b(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color)\(/g;
/** 声明左侧必须是属性名形态（`color`、`-webkit-box-shadow`、`--agent-tree-accent`），把选择器段排除掉。 */
const CSS_PROPERTY = /^(?:--)?-?[a-zA-Z][\w-]*$/;

interface DeclarationValue {
  property: string;
  /** 值在源码里的起始偏移（冒号之后）。 */
  start: number;
  /** 值在源码里的结束偏移（不含分隔符）。 */
  end: number;
}

/**
 * 把注释与引号字符串替换成等长空白。
 *
 * 判定只跑在掩码文本上，位置仍然按原文偏移取——掩码是等长替换，`line:column` 因此不会漂移；
 * 这也是为什么不做「先删注释再扫描」：那会让所有位置信息失效。
 */
function maskNonCode(source: string): string {
  const masked = source.split("");
  const blank = (from: number, to: number) => {
    for (let index = from; index < Math.min(to, masked.length); index += 1) {
      if (masked[index] !== "\n" && masked[index] !== "\r") masked[index] = " ";
    }
  };

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "/" || source[index + 1] !== "*") continue;
    const end = source.indexOf("*/", index + 2);
    const stop = end === -1 ? source.length : end + 2;
    blank(index, stop);
    index = stop - 1;
  }

  let quote: '"' | "'" | null = null;
  for (let index = 0; index < masked.length; index += 1) {
    const character = masked[index];
    if (quote === null) {
      if (character === '"' || character === "'") {
        quote = character;
        blank(index, index + 1);
      }
      continue;
    }
    blank(index, index + 1);
    if (character === "\\") {
      blank(index + 1, index + 2);
      index += 1;
    } else if (character === quote) {
      quote = null;
    }
  }

  return masked.join("");
}

/**
 * 拆出所有声明值。
 *
 * 按顶层（括号深度为 0）的 `;` / `{` / `}` 切段，段内首个 `:` 之前是属性、之后是值：
 * at-rule 预lude 与无块 at-rule 因以 `@` 开头被整段跳过，选择器段因属性名形态不符被 `CSS_PROPERTY` 挡掉。
 */
function declarationValues(masked: string): DeclarationValue[] {
  const values: DeclarationValue[] = [];
  let start = 0;
  let depth = 0;

  const take = (end: number) => {
    const segment = masked.slice(start, end);
    if (segment.trimStart().startsWith("@")) return;
    const colon = segment.indexOf(":");
    if (colon === -1) return;
    const property = segment.slice(0, colon).trim();
    if (!CSS_PROPERTY.test(property)) return;
    values.push({ property, start: start + colon + 1, end });
  };

  for (let index = 0; index < masked.length; index += 1) {
    const character = masked[index];
    if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (character === ";" || character === "{" || character === "}")) {
      take(index);
      start = index + 1;
    }
  }
  take(masked.length);

  return values;
}

/** 4 / 8 位 hex 的最后一截是 alpha，为 0 即透明色。 */
function isTransparentHexColor(hex: string): boolean {
  const digits = hex.slice(1);
  if (digits.length === 4) return digits[3] === "0";
  if (digits.length === 8) return digits.slice(6) === "00";
  return false;
}

/** 取整段函数调用文本（括号配对）作为证据 token；括号不配平时退化为从函数名到值末尾。 */
function readFunctionCall(text: string, start: number): string {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return text.slice(start);
}

interface LiteralHit {
  ruleId: WebStyleRuleId;
  /** 相对值起点的偏移。 */
  index: number;
  token: string;
}

/** 在单个声明值里找长度 / 颜色字面量，按出现顺序返回。 */
function literalsIn(text: string): LiteralHit[] {
  const hits: LiteralHit[] = [];

  for (const match of text.matchAll(LENGTH_LITERAL)) {
    if (Number(match[1]) === 0) continue;
    hits.push({ ruleId: "FCP-WEB-07", index: match.index, token: match[0] });
  }
  for (const match of text.matchAll(HEX_COLOR_LITERAL)) {
    if (isTransparentHexColor(match[0])) continue;
    hits.push({ ruleId: "FCP-WEB-08", index: match.index, token: match[0] });
  }
  for (const match of text.matchAll(COLOR_FUNCTION_LITERAL)) {
    hits.push({ ruleId: "FCP-WEB-08", index: match.index, token: readFunctionCall(text, match.index) });
  }

  return hits.sort((left, right) => left.index - right.index);
}

/** 行首偏移表；配合二分把绝对偏移换算成 1 基的行列。 */
function buildLineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function positionAt(lineStarts: readonly number[], index: number): { line: number; column: number } {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((lineStarts[middle] ?? 0) <= index) low = middle;
    else high = middle - 1;
  }
  return { line: low + 1, column: index - (lineStarts[low] ?? 0) + 1 };
}

/** 扫描一份伴随表源码，返回全部长度 / 颜色字面量命中，按位置排序。 */
export function findCssLiteralViolations(filePath: string, source: string): WebStyleViolation[] {
  const masked = maskNonCode(source);
  const lineStarts = buildLineStarts(source);
  const violations: WebStyleViolation[] = [];

  for (const value of declarationValues(masked)) {
    const text = masked.slice(value.start, value.end);
    for (const hit of literalsIn(text)) {
      const position = positionAt(lineStarts, value.start + hit.index);
      violations.push({ ruleId: hit.ruleId, filePath, line: position.line, column: position.column, token: hit.token });
    }
  }

  return violations.sort((left, right) => left.line - right.line || left.column - right.column);
}
