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
 * - 阈值型判据（如「单个 className 里任意值超过 N 个」）在拿到真实数据前不实现，避免制造模糊告警。
 * - `FCP-WEB-04/05/06` 是**死类**判定（写了但不会生成任何声明），只做纯语法推导，不调用编译引擎，
 *   也不读 `dist/`——门禁步骤不该要求先构建。每个刻度表都用编译接口实测过正反例，见各常量处的说明。
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
  {
    id: "FCP-WEB-04",
    level: "P1",
    title: "负号写在工具名之后",
    detail: "负值工具类的负号必须在工具名之前（-ml-1.75）；写成双短横的 ml--1.75 是死类，构建期不产出任何声明",
  },
  {
    id: "FCP-WEB-05",
    level: "P1",
    title: "间距刻度不是 0.25 的整数倍",
    detail:
      "间距刻度的裸值乘 4 必须是整数（h-4.6 的 4.6×4=18.4 不行，ml-1.8 的 1.8×4=7.2 不行）——刻度表达不了的数值是死类",
  },
  {
    id: "FCP-WEB-06",
    level: "P1",
    title: "刻度族收到了不接受的数值",
    detail:
      "auto-rows-* / auto-cols-* 只收 min / max / fr / auto 一类关键字（不收任何数字），grid-cols-* / grid-rows-* 只收非负整数（不收小数）——写了不受支持的数值即死类",
  },
] as const satisfies readonly WebStyleRule[];

export type WebStyleRuleId = "FCP-WEB-01" | "FCP-WEB-02" | "FCP-WEB-03" | "FCP-WEB-04" | "FCP-WEB-05" | "FCP-WEB-06";

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
 * 负号错位的形态：工具名之后紧跟 `--` 加数字（`ml--1.8`、`outline-offset--2`）。
 *
 * 口径只收「双短横 + 数字」这一种形状，不是「凡双短横皆可疑」：v4 里 `bg-(--brand)`、
 * `bg-[--brand]` 是合法的 CSS 变量引用，BEM 的 `block--modifier` 类名也长这样。
 * 前两类已被「方括号/圆括号内容不参与判定」排除，后一类靠「`--` 后面必须紧跟数字」避开
 * ——`block--active` 这类修饰名不报。这是刻意的收窄：宁可漏报也不误报。
 */
const MISPLACED_NEGATIVE = /--\d/;

/**
 * 间距刻度的工具名（裸值形态）。v4 把它们编译成 `calc(var(--spacing) * 值)`，
 * 而 `--spacing` 的裸值必须是 0.25 的整数倍（逐候选实测：`ml-1.75` 生成、`ml-1.8` 不生成）。
 *
 * 只登记**实测过**的那些族：本表每个前缀都用 `tailwindcss@4.3.0` 的编译接口验证过
 * 「无效小数不生成声明、有效小数生成声明」。没验证过的族（如 `basis-*`）不收，
 * 缺一个前缀只会漏报，收错了就会误报——两者的代价不对称。
 */
const SPACING_SCALE_PREFIXES = new Set([
  "m",
  "mx",
  "my",
  "mt",
  "mr",
  "mb",
  "ml",
  "ms",
  "me",
  "p",
  "px",
  "py",
  "pt",
  "pr",
  "pb",
  "pl",
  "ps",
  "pe",
  "gap",
  "gap-x",
  "gap-y",
  "w",
  "h",
  "size",
  "min-w",
  "max-w",
  "min-h",
  "max-h",
  "inset",
  "inset-x",
  "inset-y",
  "top",
  "right",
  "bottom",
  "left",
  "start",
  "end",
  "space-x",
  "space-y",
  "translate-x",
  "translate-y",
  "scroll-m",
  "scroll-mx",
  "scroll-my",
  "scroll-mt",
  "scroll-mr",
  "scroll-mb",
  "scroll-ml",
  "scroll-p",
  "scroll-px",
  "scroll-py",
  "scroll-pt",
  "scroll-pr",
  "scroll-pb",
  "scroll-pl",
]);

/** 完全不收数字的刻度族：只收 `min` / `max` / `fr` / `auto` 等关键字。 */
const KEYWORD_ONLY_SCALE_FAMILIES = new Set(["auto-rows", "auto-cols"]);

/** 只收非负整数的刻度族：`grid-cols-2` 生成，`grid-cols-2.5` 不生成。 */
const INTEGER_SCALE_FAMILIES = new Set(["grid-cols", "grid-rows"]);

/** `<工具名>-<值>` 的裸值形态；变体已在调用方按顶层冒号切掉。 */
const BARE_UTILITY = /^([a-z][a-z0-9-]*)-(.+)$/;
/** 裸数字值：整数或小数（`2`、`2.5`、`1.75`）。 */
const BARE_NUMBER = /^\d+(?:\.\d+)?$/;
/** 仅小数形态的裸值（`4.6`），用于「只收整数」的刻度族判定。 */
const BARE_DECIMAL = /^\d+\.\d+$/;

/**
 * 裸值是否是 0.25 的整数倍——即该数值能否被 `calc(var(--spacing) * n)` 精确表达。
 *
 * 用整数运算而不是浮点乘除：`1.8 * 4` 在 IEEE754 下是 `7.2000000000000001`，
 * 拿它做 `Number.isInteger` 判定会得到「不是整数」的正确结论，但 `0.75 * 4` 一类
 * 边界值要靠误差容忍才稳；把小数点后两位放大成整数（`1.8 → 180`）则完全无误差。
 */
function isQuarterStepMultiplier(value: string): boolean {
  const scaled = Math.round(Number(value) * 100);
  return (scaled * 4) % 100 === 0;
}

/**
 * 判定「裸值」侧的死类：04 负号错位、05 刻度不合法、06 刻度族不收这个数值。
 *
 * 只处理不含方括号的裸值——任意值（`-[...]`）走 01/02 的路径，两者互斥。
 * 判定前先摘掉 `!`（important）与前置负号：它们都是合法前缀，不参与规则判定。
 */
function classifyBareValueToken(value: string): WebStyleRuleId | null {
  if (value.includes("[") || value.includes("(")) return null;

  const body = value.replace(/^!?-?/, "");
  if (MISPLACED_NEGATIVE.test(body)) return "FCP-WEB-04";

  const bare = BARE_UTILITY.exec(body);
  if (bare === null) return null;
  const [, utility, bareValue] = bare;
  if (!BARE_NUMBER.test(bareValue)) return null;

  if (SPACING_SCALE_PREFIXES.has(utility)) {
    return isQuarterStepMultiplier(bareValue) ? null : "FCP-WEB-05";
  }
  if (KEYWORD_ONLY_SCALE_FAMILIES.has(utility)) return "FCP-WEB-06";
  if (INTEGER_SCALE_FAMILIES.has(utility)) return BARE_DECIMAL.test(bareValue) ? "FCP-WEB-06" : null;
  return null;
}

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
 * 优先级：变体（响应式 03 / 选择器嵌套 02）先于值（01 与 04/05/06）。一个 token 只报一条，
 * 因为「用什么规则修」由最外层写法决定——`[&>svg]:w-[11px]` 要改的是结构表达式，单改 `w-[11px]` 无意义。
 * 同理，`has-[>button]:ml--1.75` 要改的是值侧的负号写法，而不是 `has-[...]` 这个合法变体。
 */
export function classifyClassToken(token: string): WebStyleRuleId | null {
  // 快速通道：变体侧的两条规则都要求出现方括号；没有方括号就只剩值侧要判。
  if (!token.includes("[")) return classifyBareValueToken(lastSegmentOf(token));

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
  // 值侧不是任意值时（`has-[>button]:ml--1.75` 这种「合法变体 + 裸值」）继续走 04/05/06。
  if (arbitraryValue === undefined) return classifyBareValueToken(value);
  if (arbitraryValue.includes(CSS_VARIABLE_REFERENCE)) return null;
  if (LENGTH_VALUE.test(arbitraryValue) || COLOR_VALUE.test(arbitraryValue)) return "FCP-WEB-01";
  if (COMPOSITE_VALUE.test(arbitraryValue)) return "FCP-WEB-02";
  return null;
}

/** 取顶层最后一个冒号之后的片段，即去掉全部变体后的工具名。 */
function lastSegmentOf(token: string): string {
  const segments = splitTopLevel(token);
  return segments[segments.length - 1] ?? "";
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
