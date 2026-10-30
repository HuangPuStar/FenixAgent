/**
 * 聊天正文交给 streamdown 的插件注册常量。
 *
 * 为什么是模块级常量而不是宿主 prop：开放成 prop 会让每个调用点各持一份配置（撤销、比对、测试都要
 * 逐点改），而 renderer 本身与宿主无关；宿主侧只需要 `plugins={MESSAGE_PLUGINS}` 一处接线。
 *
 * 依赖边界：本模块会静态拉起 `math-plugin`（→ `@streamdown/math` → rehype-katex → katex），因此
 * **只能**经 `message-markdown.tsx` 的惰性边界到达，不得从包 barrel（`web/index.ts` / `chat/index.ts`）或任何
 * eager 模块静态转出；KaTeX 样式表由 `lib/katex-math` 的 `loadKatexStyles` 动态引入（唯一引入点）。
 */

import type { PluginConfig } from "streamdown";
import { loadKatexStyles } from "../../lib/katex-math";
import { createChatKatexPlugin } from "./math-plugin";

// KaTeX 样式表：数学渲染必须带样式，否则公式退回浏览器默认排版。本模块只经 `message.tsx` 的惰性边界
// 到达，故这里的触发点不会把样式表带进首屏。
void loadKatexStyles();

/** streamdown 插件配置：OpenUI 围栏由 `MessageResponse` 在交给 streamdown 前自行切分，这里只留数学。 */
export const MESSAGE_PLUGINS: PluginConfig = {
  math: createChatKatexPlugin(),
};
