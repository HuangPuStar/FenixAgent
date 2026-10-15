/**
 * KaTeX 渲染策略的**唯一真相**（2026-10-15 数学渲染批次）。
 *
 * 两条渲染链都在这里取配置，不得各写一份：
 * 1. 聊天正文：`streamdown` + `@streamdown/math`（remark-math → rehype-katex → katex）——工厂在
 *    `web/chat/ui-spec/math-plugin.ts`（它静态引 `@streamdown/math`，因此**只能**被惰性 chunk 引入，
 *    见该文件头），选项来自本模块的策略常量。
 * 2. 文件预览：`.md` 的 `markdown-math-plugin`（KaTeX auto-render）与 `.tex` 的 `latex-content`
 *    （`katex.renderToString`）——分别取 `KATEX_AUTO_RENDER_DELIMITERS` 与 `katexRenderOptions()`。
 *
 * 三条策略与它们的落点：
 * - **单 `$` 行内公式**（`KATEX_SINGLE_DOLLAR_TEXT_MATH`）：两条链都开。KaTeX 的 auto-render 默认**不**认
 *   单 `$`（`$` 在正文里常是货币符号），remark-math 的默认也关着；这里显式开启，因为 AI 产出的 markdown
 *   里行内公式就是 `$…$`。代价与记录见包 README 已知限制第 15 条（成对美元金额会被当公式，按错误色渲染）。
 * - **错误色**（`KATEX_ERROR_COLOR`）：`#cc0000` 是 KaTeX 自己的默认值。**刻意不用 `var(--color-*)`
 *   token**：Tailwind v4 会裁掉未被工具类引用的主题变量，实测 `--color-muted-foreground` 不在构建产物里，
 *   用 token 会让错误文本拿到非法颜色（`@streamdown/math` 的默认值正是那个 token，所以必须显式覆盖）。
 * - **降级策略**：KaTeX 认不出的宏/环境不得让正文消失。两条链实现方式不同但语义一致——先探错、再按错误色
 *   就地渲染、连错误态都失败时回退源码：聊天侧由 `rehype-katex` 自己完成（`throwOnError: true` → 记 vfile
 *   消息 → `throwOnError: false, strict: ignore` → 自造 `katex-error` 节点），预览侧由
 *   `latex-content.tsx` 的 `renderMath` 完成。因此这里不重复实现，只提供各自的选项。
 *
 * `KATEX_MACROS` 目前为空：预览侧直接吃这份映射；聊天侧经 `createMathPlugin` 构造时**没有**传宏的口子，
 * 需要给聊天加宏时改法是换掉 `rehypePlugin` 那一元组（`[rehypeKatex, { macros }]`），不是各写一份清单。
 */

import type { KatexOptions } from "katex";

/** 是否把单 `$…$` 当行内公式：聊天与预览共用这一个开关（代价见文件头与 README 已知限制第 15 条）。 */
export const KATEX_SINGLE_DOLLAR_TEXT_MATH = true;

/** KaTeX 错误态文本颜色（未支持的宏/环境就地渲染时的颜色）。 */
export const KATEX_ERROR_COLOR = "#cc0000";

/** 自定义宏：单点维护，预览两条路径共用（聊天侧接入方式见文件头）。 */
export const KATEX_MACROS: Readonly<Record<string, string>> = {};

/**
 * KaTeX 样式表的**唯一引入点**。
 *
 * 为什么是动态导入：样式表要跟着「真正用到 KaTeX」的 chunk 走，不能进首屏。调用点有三处——
 * 聊天侧挂在 streamdown 的惰性边界上（`chat/primitives/message.tsx`），预览侧在 math 插件与
 * `.tex` 渲染层加载时触发。三处都调它，且只有它 `import` 这个 CSS 文件。
 */
export function loadKatexStyles(): Promise<unknown> {
  return import("katex/dist/katex.min.css");
}

/**
 * auto-render（预览的 `.md` 数学）用的定界符表。
 *
 * 传 `delimiters` 会整份替换 KaTeX 的内置列表，所以 AMS 环境那几条要跟着写进来；`\(`、`\[` 不列——
 * markdown 的转义规则会吃掉反斜杠，定界符到不了 DOM。
 */
export const KATEX_AUTO_RENDER_DELIMITERS: readonly { left: string; right: string; display: boolean }[] = [
  // `$$` 必须排在 `$` 前面：自动渲染按顺序取第一个命中的定界符
  { left: "$$", right: "$$", display: true },
  ...(KATEX_SINGLE_DOLLAR_TEXT_MATH ? [{ left: "$", right: "$", display: false }] : []),
  { left: "\\begin{equation}", right: "\\end{equation}", display: true },
  { left: "\\begin{align}", right: "\\end{align}", display: true },
  { left: "\\begin{alignat}", right: "\\end{alignat}", display: true },
  { left: "\\begin{gather}", right: "\\end{gather}", display: true },
];

/**
 * `katex.renderToString` 的渲染选项（预览的 `.tex` 渲染层用）。
 *
 * `trust` 固定 false：预览内容是 UGC，不放行 `\href` / `\htmlClass` 之类的原始 HTML 通道。
 */
export function katexRenderOptions(options: { displayMode: boolean; throwOnError: boolean }): KatexOptions {
  return {
    displayMode: options.displayMode,
    throwOnError: options.throwOnError,
    strict: false,
    trust: false,
    errorColor: KATEX_ERROR_COLOR,
    // 每次现拷一份：KaTeX 的 `macros` 是可变对象（`\gdef` 会往里写），共享同一个会让一份文档的宏定义
    // 泄漏到下一个预览的文件里。代价是同篇文档内 `\gdef` 不跨公式保持，这个取舍对预览是可接受的。
    macros: { ...KATEX_MACROS },
  };
}
