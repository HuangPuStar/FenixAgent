/**
 * Web 样式禁止行为（`FCP-WEB-*`）的规则表与检测核心。
 *
 * 规则由 `docs/developer/guide/forbidden-code-patterns.md` 定义，本模块是它的**可执行实现**：
 * 只负责「从一段源码里找出命中的类名 token」，不遍历文件、不读台账，因此单测可以直接喂代码片段，
 * 也能反过来用同一份反例锁住规则口径（规则改了、文档没改，或反之，都会在测试里露出来）。
 *
 * 为什么用 TypeScript AST 取字符串字面量，而不是整文件正则：反例代码经常**出现在注释里**
 * （「不要这样写：`text-[12px]`」），正则会把注释本身报成违规。类名 token 只可能出现在字符串
 * 字面量里，以字面量为单位扫描即可零误报，位置信息也更准确。
 *
 * 已知取舍：
 * - 位置按**源文本偏移**计算（含转义序列按原文计数），带 `\n` 等转义的极端字符串列号会有偏差，
 *   行号始终正确；本门禁用于定位而非精确编辑，不为此引入更重的映射。
 * - 仅覆盖 `docs/developer/guide/forbidden-code-patterns.md` 登记的三条信号；阈值型判据（如
 *   「单个 className 里任意值超过 N 个」）在拿到真实数据前不实现，避免制造模糊告警。
 */

import ts from "typescript";

/** 一条被禁止的样式写法。`level` 与文档一致：`P1` 表示严格禁止、命中数必须清零。 */
export interface WebStyleRule {
  id: WebStyleRuleId;
  level: "P1";
  title: string;
  /** 判定口径的一句话说明；同时用于失败输出，保证「报错信息 == 文档口径」。 */
  detail: string;
}

export const WEB_STYLE_RULES = [
  {
    id: "FCP-WEB-01",
    level: "P1",
    title: "任意值工具类",
    detail: "能用标准刻度或 token 表达的尺寸/颜色写成了 -[...] 任意值（如 text-[12px]、border-[#e0e7f0]）",
  },
  {
    id: "FCP-WEB-02",
    level: "P1",
    title: "深层样式堆在 className 里",
    detail:
      "需要选择器嵌套（[&>span]:、[&:hover]:）或复合表达式（shadow-[0_4px_14px_rgb(...)]、grid-cols-[...minmax(...)])才能表达的样式，应下沉为 CSS 类",
  },
  {
    id: "FCP-WEB-03",
    level: "P1",
    title: "手写响应式变体",
    detail: "用任意 at-rule 变体（[@media...]:、[@supports...]:）或任意断点（min-[760px]:）做响应式，应改用规范断点",
  },
] as const satisfies readonly WebStyleRule[];

export type WebStyleRuleId = "FCP-WEB-01" | "FCP-WEB-02" | "FCP-WEB-03";

/** 默认文档路径，失败输出里指回规则定义处。 */
export const WEB_STYLE_RULES_DOC = "docs/developer/guide/forbidden-code-patterns.md";

/** 一处命中。`token` 是原始类名 token，失败输出直接引用，不需要读源码回查。 */
export interface WebStyleViolation {
  ruleId: WebStyleRuleId;
  /** 仓库相对路径，POSIX 分隔。 */
  filePath: string;
  line: number;
  column: number;
  token: string;
}

/** 单一刻度：纯数字 + px/rem/em，例如 `12px`、`1.5rem`。 */
const LENGTH_VALUE = /^[0-9.]+(?:px|rem|em)$/;
/** 颜色字面量：十六进制或颜色函数，例如 `#e0e7f0`、`rgb(255_255_255_/_94%)`。 */
const COLOR_VALUE = /^(?:#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color)\(.*\))$/i;
/** 值侧的任意值写法；允许 Tailwind 的 `/透明度` 后缀。 */
const ARBITRARY_VALUE = /^(.*?)-\[([^\]]+)\](?:\/\d+(?:\.\d+)?)?$/;
/** 整个变体被方括号包住的「任意变体」，例如 `[&>span]`、`[@media(...)]`。 */
const WHOLE_ARBITRARY_VARIANT = /^\[([^\]]+)\]$/;
/** 函数式任意断点变体，例如 `min-[760px]`、`max-[1119px]`。 */
const BREAKPOINT_VARIANT = /^(?:min|max)-\[([^\]]+)\]$/;
/** 值里出现下划线（Tailwind 的空格转义）或函数调用，说明它不是单一刻度而是复合表达式。 */
const COMPOSITE_VALUE = /[_(]/;
/**
 * CSS 变量引用是 token 体系的合法延伸，不是「硬编码刻度」。
 * 例如 `bg-[var(--surface-1)]`、`w-[calc(var(--rail)*2)]` 属于允许的逃生舱口，不报。
 */
const CSS_VARIABLE_REFERENCE = "var(";

/**
 * 按顶层分隔符切分 token。方括号内的分隔符属于任意值/任意变体自身，
 * 例如 `[@media(min-width:760px)]:hidden` 只能切成 `[@media(min-width:760px)]` 与 `hidden`。
 */
export function splitTopLevel(token: string, separator = ":"): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;

  for (const character of token) {
    if (character === "[") depth += 1;
    else if (character === "]") depth -= 1;

    if (character === separator && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }

  parts.push(current);
  return parts;
}

/**
 * 判定单个类名 token 命中的规则；无命中返回 `null`。
 *
 * 优先级：变体（响应式 03 / 选择器嵌套 02）先于值（01）。一个 token 只报一条，
 * 因为「用什么规则修」由最外层写法决定——`[&>svg]:w-[11px]` 要改的是结构表达式，单改 `w-[11px]` 无意义。
 */
export function classifyClassToken(token: string): WebStyleRuleId | null {
  // 快速通道：三条规则都要求出现任意值/任意变体语法。
  if (!token.includes("[")) return null;

  const segments = splitTopLevel(token);
  const value = segments.pop() ?? "";

  let nestedSelector: WebStyleRuleId | null = null;
  for (const variant of segments) {
    const arbitraryVariant = WHOLE_ARBITRARY_VARIANT.exec(variant)?.[1];
    if (arbitraryVariant?.startsWith("@")) return "FCP-WEB-03";
    if (arbitraryVariant?.includes("&")) nestedSelector = "FCP-WEB-02";

    const breakpoint = BREAKPOINT_VARIANT.exec(variant)?.[1];
    if (breakpoint !== undefined && LENGTH_VALUE.test(breakpoint)) return "FCP-WEB-03";
  }
  if (nestedSelector) return nestedSelector;

  const arbitraryValue = ARBITRARY_VALUE.exec(value)?.[2];
  if (arbitraryValue === undefined || arbitraryValue.includes(CSS_VARIABLE_REFERENCE)) return null;
  if (LENGTH_VALUE.test(arbitraryValue) || COLOR_VALUE.test(arbitraryValue)) return "FCP-WEB-01";
  if (COMPOSITE_VALUE.test(arbitraryValue)) return "FCP-WEB-02";
  return null;
}

/** 一段字符串字面量的内容及其在源文件中的起始偏移。 */
interface StringChunk {
  text: string;
  /** `text` 第一个字符在源码中的偏移；模板字面量按各段分别计算。 */
  offset: number;
}

/** 取模板字面量某一段（head / middle / tail）的内容，去掉包裹它的反引号、`${` 与 `}`。 */
function readTemplateChunk(raw: string, kind: "head" | "middle" | "tail"): string {
  const tailLength = kind === "tail" ? 1 : 2;
  return raw.slice(1, Math.max(1, raw.length - tailLength));
}

/** 从节点里取出所有「可能是类名载体」的字符串片段；非字符串节点返回空数组。 */
function stringChunksOf(node: ts.Node, source: string): StringChunk[] {
  if (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node) && !ts.isTemplateExpression(node)) {
    return [];
  }

  // 按偏移切片而不是用 `getText()`：切片不依赖 parent 指针，且能把转义序列按原文计数。
  const raw = source.slice(node.getStart(), node.getEnd());

  if (ts.isStringLiteral(node)) return [{ text: raw.slice(1, -1), offset: node.getStart() + 1 }];

  if (ts.isNoSubstitutionTemplateLiteral(node)) {
    return [{ text: readTemplateChunk(raw, "tail"), offset: node.getStart() + 1 }];
  }

  const template = node as ts.TemplateExpression;
  return [
    {
      text: readTemplateChunk(source.slice(template.head.getStart(), template.head.getEnd()), "head"),
      offset: template.head.getStart() + 1,
    },
    ...template.templateSpans.map((span) => ({
      text: readTemplateChunk(
        source.slice(span.literal.getStart(), span.literal.getEnd()),
        ts.isTemplateTail(span.literal) ? "tail" : "middle",
      ),
      offset: span.literal.getStart() + 1,
    })),
  ];
}

/** 深度优先遍历语法树。 */
function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

/**
 * 扫描一段源码，返回全部命中。
 *
 * `filePath` 只用于结果的路径字段，不参与解析（脚本名与扩展名决定 `ScriptKind`）。
 */
export function findWebStyleViolations(filePath: string, source: string): WebStyleViolation[] {
  const scriptKind = filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind);
  const violations: WebStyleViolation[] = [];

  walk(sourceFile, (node) => {
    for (const chunk of stringChunksOf(node, source)) {
      for (const match of chunk.text.matchAll(/\S+/g)) {
        const ruleId = classifyClassToken(match[0]);
        if (ruleId === null) continue;

        const position = sourceFile.getLineAndCharacterOfPosition(chunk.offset + match.index);
        violations.push({
          ruleId,
          filePath,
          line: position.line + 1,
          column: position.character + 1,
          token: match[0],
        });
      }
    }
  });

  return violations;
}
