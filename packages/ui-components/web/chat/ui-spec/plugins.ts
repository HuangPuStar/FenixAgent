/**
 * 聊天正文交给 streamdown 的插件注册常量（计划 §1.1 冻结接口）。
 *
 * 为什么是模块级常量而不是宿主 prop：开放成 prop 会让每个调用点各持一份配置（撤销、比对、测试都要
 * 逐点改），而 renderer 本身与宿主无关；宿主侧只需要 `plugins={UI_SPEC_PLUGINS}` 一处接线。
 *
 * 内容有两项：`ui-spec` 自定义围栏渲染器，以及数学渲染（2026-10-15 批次，`@streamdown/math`）。
 * 数学插件由 `lib/katex-math` 的策略构造——单 `$` 行内公式、错误色、降级语义都在那里定义，与文件预览
 * 共用同一份（预览侧的 md 数学走 KaTeX auto-render、`.tex` 走 renderToString，见该模块文件头）。
 *
 * 依赖边界（§5.2 懒加载边界）：本模块会静态拉起 `math-plugin`（→ `@streamdown/math` → rehype-katex →
 * katex），因此**只能**经 `message.tsx` 的惰性边界到达，不得从包 barrel（`web/index.ts` / `chat/index.ts`）
 * 或任何 eager 模块静态转出；KaTeX 样式表由 `lib/katex-math` 的 `loadKatexStyles` 动态引入（唯一引入点）。
 * streamdown 的容器 / 标题 / 骨架仍在 `UISpecBlock` 内部动态加载。
 */

import type { PluginConfig } from "streamdown";
import { loadKatexStyles } from "../../lib/katex-math";
import { createChatKatexPlugin } from "./math-plugin";
import { UI_SPEC_LANGUAGE } from "./spec";
import { UISpecBlock } from "./UISpecBlock";

// KaTeX 样式表：数学渲染必须带样式，否则公式退回浏览器默认排版。本模块只经 `message.tsx` 的惰性边界
// 到达，故这里的触发点不会把样式表带进首屏。
void loadKatexStyles();

/** 围栏语言标识：正文里写成 ```ui-spec。定义在 `spec.ts`（解析侧与注册侧共用），此处再导出保持既有引用路径。 */
export { UI_SPEC_LANGUAGE };

/** streamdown 插件配置：把 `ui-spec` 围栏交给自有渲染器、把数学交给 KaTeX；撤销本常量即恢复普通代码块与纯文本公式。 */
export const UI_SPEC_PLUGINS: PluginConfig = {
  renderers: [{ language: UI_SPEC_LANGUAGE, component: UISpecBlock }],
  math: createChatKatexPlugin(),
};
