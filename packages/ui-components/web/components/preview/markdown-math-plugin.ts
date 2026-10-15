/**
 * Markdown 预览的数学渲染插件：在既有 markdown 渲染链上加一层 KaTeX。
 *
 * **为什么是「包一层」而不是自己渲染 markdown**：`@open-file-viewer` 的 `textPlugin` 已经把 markdown
 * 渲染完整（marked + DOMPurify + Prism 高亮 + 缩放控制），扩展名为 md / markdown 时它走独立分支。
 * 这里把它的实例拿过来跑在同一份 ctx 上，渲染完成后对 DOM 做一次 KaTeX 自动渲染——
 * 引入 `react-markdown` / `streamdown` 之类的第二套 markdown 实现会立刻产生两份排版真相（DOM 结构、
 * 安全策略、代码高亮各不相同），正是要避免的重复建设。
 *
 * 三个取舍（策略值全部来自 `lib/katex-math`，与聊天渲染链共用同一份，不在这里另立）：
 * 1. **定界符见 `KATEX_AUTO_RENDER_DELIMITERS`**：只留能在 markdown 里活下来的形式（`$` / `$$` 与 AMS
 *    环境——`\(`、`\[` 的反斜杠会被 markdown 的转义规则吃掉）。单 `$` 的开关是策略常量，聊天侧的
 *    remark-math 由同一个常量驱动，两边判定一致。
 * 2. **`throwOnError: false`**：KaTeX 不支持的宏在公式位置渲染成错误态（`KATEX_ERROR_COLOR`）而不是
 *    抛异常，一篇文档里有一个坏公式不会让整篇预览白屏。解析告警只进 `errorCallback` 日志。
 * 3. **跳过代码块**：`ignoredTags` 保留 KaTeX 默认的 `pre` / `code`，避免把示例代码里的 `$` 当公式。
 *
 * 样式表经 `loadKatexStyles()` 与自动渲染同时加载（该函数是 CSS 的唯一引入点）：`.md` 的公式同样需要
 * KaTeX 的字体与排版类，缺了会退回浏览器默认排版。
 *
 * 插件名与 `html-plugin` 同风格（`fenix-` 前缀），宿主按名排序/去重时行为可预期。
 */

import type { PreviewPlugin } from "@open-file-viewer/core";
import { textPlugin } from "@open-file-viewer/core";
import { KATEX_AUTO_RENDER_DELIMITERS, KATEX_ERROR_COLOR, loadKatexStyles } from "../../lib/katex-math";
import { isMarkdownExtension } from "./preview-source";

export function markdownMathPlugin(): PreviewPlugin {
  // 每条 markdown 预览都复用同一个基础插件实例：它无状态（每次 render 现建 DOM）
  const base = textPlugin();

  return {
    name: "fenix-markdown-math",

    match(file) {
      return isMarkdownExtension(file.extension ?? "");
    },

    async render(ctx) {
      const instance = await base.render(ctx);
      // 按需加载：KaTeX 与其样式表只在真正预览 markdown 时进入运行时，不进预览面板的首屏静态图
      const [{ default: renderMathInElement }] = await Promise.all([
        import("katex/contrib/auto-render"),
        loadKatexStyles(),
      ]);
      renderMathInElement(ctx.viewport, {
        delimiters: KATEX_AUTO_RENDER_DELIMITERS,
        ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code", "option"],
        throwOnError: false,
        strict: false,
        errorColor: KATEX_ERROR_COLOR,
        errorCallback: (message) => console.warn("[markdownMathPlugin] KaTeX 解析告警", message),
      });
      return instance;
    },
  };
}
