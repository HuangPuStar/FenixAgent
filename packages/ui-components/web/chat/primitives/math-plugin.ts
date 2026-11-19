/**
 * 聊天侧（streamdown）的数学插件工厂：`@streamdown/math` 的官方工厂 + `lib/katex-math` 的策略。
 *
 * **本模块只能被惰性 chunk 引入**（当前唯一引入方是 `primitives/message-plugins.ts`，而后者只经
 * `chat/primitives/message-markdown.tsx` 的 `lazy(() => import(...))` 边界到达）。原因：`@streamdown/math` 静态
 * 引 `rehype-katex`、后者静态引 `katex`，一旦有 eager 模块（尤其是包 barrel `web/index.ts`）静态转出
 * 本模块，KaTeX 就会被打进入口 chunk——2026-10-15 实测过这个形态：`index.html` 里出现
 * `modulepreload katex-*.js`。守卫见 `web/__tests__/katex-math.test.ts`（样式表与选项字面量的单点断言）。
 *
 * 为什么经 `createMathPlugin` 而不是直接用 `math` 常量：`math` 的默认值是「不认单 `$`」且错误色取
 * `var(--color-muted-foreground)`（本仓构建产物里没有这个变量，见 `lib/katex-math.ts` 文件头），
 * 两项都必须按共享策略覆盖。
 */

import { createMathPlugin } from "@streamdown/math";
import { KATEX_ERROR_COLOR, KATEX_SINGLE_DOLLAR_TEXT_MATH } from "../../lib/katex-math";

/** 数学节点的解析位置与 HTML 提示；不依赖解析器包内的实现类型。 */
interface MarkdownNode {
  type: string;
  children?: MarkdownNode[];
  data?: { hProperties?: { className?: string[] } };
  properties?: { className?: string[] };
  position?: { start: { offset?: number }; end: { offset?: number } };
}

// streamdown 的 sanitizer 只保留 language-* 类；display 标记须在安全过滤后再还原给 KaTeX。
const DISPLAY_MATH_CLASS = "language-math-display";

/** 创建聊天公式插件：双美元使用 display 模式，根级块公式允许定界符与内容同行。 */
export function createChatKatexPlugin(): ReturnType<typeof createMathPlugin> {
  const plugin = createMathPlugin({
    singleDollarTextMath: KATEX_SINGLE_DOLLAR_TEXT_MATH,
    errorColor: KATEX_ERROR_COLOR,
  });
  const remark = plugin.remarkPlugin;
  if (!Array.isArray(remark) || typeof remark[0] !== "function") {
    throw new Error("Unexpected math plugin configuration");
  }
  const [remarkMath, options] = remark;
  plugin.remarkPlugin = [
    function remarkChatMath(settings: unknown) {
      Reflect.apply(remarkMath, this, [settings]);
      const parse = this.parser;
      if (!parse) throw new Error("Markdown parser is required for chat math");
      this.parser = (source, file) => {
        let tree = parse(source, file);
        // 一条坏公式可能吞掉下一条的开头；重新解析后才知道后续真实公式与代码的边界。
        // 每轮至少修正一个定界符，源码中的定界符数量限定了轮数；正常消息只解析一次。
        for (;;) {
          const normalized = normalizeMathDelimiters(source, tree);
          if (normalized === source) {
            markDisplayMath(source, tree);
            return tree;
          }
          source = normalized;
          tree = parse(source, file);
        }
      };
    },
    options,
  ];
  const rehype = plugin.rehypePlugin;
  if (!Array.isArray(rehype) || typeof rehype[0] !== "function") {
    throw new Error("Unexpected KaTeX plugin configuration");
  }
  const [rehypeKatex, katexOptions] = rehype;
  plugin.rehypePlugin = [
    function rehypeChatKatex(settings: unknown) {
      const transform = Reflect.apply(rehypeKatex, this, [settings]);
      if (typeof transform !== "function") throw new Error("KaTeX transformer is required for chat math");
      return (tree: MarkdownNode, file: unknown) => {
        restoreDisplayMath(tree);
        return Reflect.apply(transform, this, [tree, file]);
      };
    },
    katexOptions,
  ];
  return plugin;
}

/** remark-math 把同行双美元也视作 inlineMath；显式保留聊天中双美元的 display 语义。 */
function markDisplayMath(source: string, node: MarkdownNode): void {
  const start = node.position?.start.offset;
  const properties = node.data?.hProperties;
  if (node.type === "inlineMath" && start !== undefined && source.startsWith("$$", start) && properties) {
    properties.className = ["language-math", DISPLAY_MATH_CLASS];
  }
  for (const child of node.children ?? []) markDisplayMath(source, child);
}

/** 在官方 KaTeX transformer 前恢复 display 语义，保留原有安全过滤与错误降级。 */
function restoreDisplayMath(node: MarkdownNode): void {
  const classes = node.properties?.className;
  if (classes?.includes("language-math") && classes.includes(DISPLAY_MATH_CLASS)) classes.push("math-display");
  for (const child of node.children ?? []) restoreDisplayMath(child);
}

/** 判断美元符号是否被奇数个反斜杠转义，避免改变公式中的字面美元符号。 */
function isEscaped(text: string, offset: number): boolean {
  let slashes = 0;
  while (offset > 0 && text[--offset] === "\\") slashes += 1;
  return slashes % 2 === 1;
}

/** 只修正解析器已识别的根级块公式；代码、行内公式和引用/列表容器均保持原语义。 */
function normalizeMathDelimiters(source: string, tree: MarkdownNode): string {
  const output: string[] = [];
  let copied = 0;
  for (const node of tree.children ?? []) {
    if (node.type !== "math") continue;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    const raw = source.slice(start, end);
    const opening = /^(\${2,})([^\r\n]*)(\r?\n)/.exec(raw);
    if (!opening) continue;
    const indent = source.slice(source.lastIndexOf("\n", start - 1) + 1, start);
    // 聊天公式没有 fence 元信息；同行的 LaTeX 必须留在公式体中，尤其是矩阵的 begin 环境。
    if (opening[2].trim()) {
      const offset = start + opening[1].length;
      output.push(source.slice(copied, offset), opening[3], indent);
      copied = offset;
      // 已独立闭合的公式只移动开头，不改变后续边界，可以批量修正，避免长消息反复整文解析。
      const lastLine = raw.slice(raw.lastIndexOf("\n") + 1).trim();
      if (/^\$+$/.test(lastLine) && lastLine.length >= opening[1].length) continue;
      return output.join("") + source.slice(copied);
    }
    for (const match of raw.slice(opening[0].length).matchAll(/[^\r\n]+/g)) {
      let lineEnd = match[0].length;
      while (match[0][lineEnd - 1] === " " || match[0][lineEnd - 1] === "\t") lineEnd -= 1;
      const line = match[0].slice(0, lineEnd);
      if (!line.endsWith(opening[1])) continue;
      let closingStart = line.length;
      while (line[closingStart - 1] === "$") closingStart -= 1;
      const prefix = line.slice(0, closingStart);
      if (isEscaped(prefix, prefix.length)) continue;
      if (prefix.trim()) {
        const offset = start + opening[0].length + match.index + prefix.length;
        output.push(source.slice(copied, offset), opening[3], indent);
        return output.join("") + source.slice(offset);
      }
      break;
    }
  }
  return output.length ? output.join("") + source.slice(copied) : source;
}
