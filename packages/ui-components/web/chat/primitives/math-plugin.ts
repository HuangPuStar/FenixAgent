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

export function createChatKatexPlugin(): ReturnType<typeof createMathPlugin> {
  return createMathPlugin({
    singleDollarTextMath: KATEX_SINGLE_DOLLAR_TEXT_MATH,
    errorColor: KATEX_ERROR_COLOR,
  });
}
