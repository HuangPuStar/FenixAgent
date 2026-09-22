/**
 * Agent markdown / streamdown 的排版工具类。
 *
 * 来源：原 `primitives/chat-message-content.css`（源 ai-elements 样式表 + 宿主 index.css 的两条
 * streamdown 全局规则）与 `css/chat-design-messages.css` 末尾三条 `.message-content:where(.chat-markdown-content)`
 * 规则，逐条下沉到同目录 `markdown-classes.css` 的容器后代选择器。
 *
 * 为什么挂在容器上而不是各元素上：markdown 的 DOM（h1/p/li/pre/code/table/… ）由第三方 streamdown
 * 渲染，本包只在 `MessageResponse` 里给它一个容器——这是我们的 JSX 能触达它们的唯一位置。
 *
 * 级联要点（决定了取值口径，勿随手改）：
 * 1. 原样式表和迁移后的 CSS 都**未包 `@layer`**，具体元素 + 后代选择器的特指度继续压过
 *    streamdown 的同名工具类，不依赖生成顺序。
 * 2. `chat-design-messages.css` 的 `ul / ol / blockquote` 三条与 ai-elements 的同类规则特指度相同
 *    （(0,1,1)），源仓库里靠 chunk 顺序决定胜者；本仓库构建产物的 `<link>` 顺序为
 *    `message-*.css`(#1) → `main-*.css`(#8) → `agent-panel-*.css`(#9)，即 `chat-design-messages.css`
 *    在最后、**胜出**。冲突项按它取值：`ul/ol` 的 `padding-left: 1.35rem`（而非 1.45rem）、
 *    `blockquote` 的 `margin-left: 0 / padding-left: 0 / border-left: 0 / background: transparent`。
 * 3. 元素级声明（color / font-size / min-width / max-width / overflow-wrap / word-break / white-space）
 *    同样按「未分层胜出」取值：`color: #27364f`、`font-size: 14px`、`overflow-wrap: anywhere`、
 *    `word-break: normal`，`--rendered` 的 `white-space: normal`。
 * 4. `font-family: inherit`（源 `:where(h1..h4)` 里那条）不迁移：Tailwind preflight 已让标题继承字体，
 *    该声明在两侧都不是生效项。
 */
import "./markdown-classes.css";

export const MARKDOWN_CONTENT_CLASS = [
  // ── 容器自身（源 `.chat-markdown-content` / `.chat-markdown-response` / `--rendered`）──
  "chat-markdown-content-styles min-w-0 max-w-full wrap-anywhere whitespace-normal [word-break:normal]",
].join(" ");
