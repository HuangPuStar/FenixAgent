/**
 * Agent markdown / streamdown 的排版工具类。
 *
 * 来源：原 `primitives/chat-message-content.css`（源 ai-elements 样式表 + 宿主 index.css 的两条
 * streamdown 全局规则）与 `css/chat-design-messages.css` 末尾三条 `.message-content:where(.chat-markdown-content)`
 * 规则，逐条改写成容器上的 arbitrary variant（`[&_tag]:` 形式）后按**合并后的生效值**落在这里。
 *
 * 为什么挂在容器上而不是各元素上：markdown 的 DOM（h1/p/li/pre/code/table/… ）由第三方 streamdown
 * 渲染，本包只在 `MessageResponse` 里给它一个容器——按口径「第三方内部 DOM 用容器上的 arbitrary variant
 * 收掉」，这是我们的 JSX 能触达它们的唯一位置。
 *
 * 级联要点（决定了取值口径，勿随手改）：
 * 1. 原样式表**未包 `@layer`**，而未分层的声明在层叠中压过 `@layer utilities` 里的一切（含 streamdown
 *    自带的 `text-3xl` / `mb-4` / `break-words` 等工具类）。迁移后本常量也是工具类，故这里刻意用
 *    「具体元素 + 后代选择器」（`[&_h1]:` = 特指度 (0,1,1)）而不是 `[&_:where(h1)]`（(0,1,0)）——
 *    保证仍然压过 streamdown 的同名工具类，不依赖生成顺序。
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
export const MARKDOWN_CONTENT_CLASS = [
  // ── 容器自身（源 `.chat-markdown-content` / `.chat-markdown-response` / `--rendered`）──
  "min-w-0 max-w-full text-[#27364f] text-[14px] wrap-anywhere whitespace-normal [word-break:normal]",
  // ── 标题：共享字重/字距/颜色 + 各自字号行高 ──
  "[&_h1,&_h2,&_h3,&_h4]:mt-[1.35em] [&_h1,&_h2,&_h3,&_h4]:mb-[0.55em] [&_h1,&_h2,&_h3,&_h4]:font-bold",
  "[&_h1,&_h2,&_h3,&_h4]:tracking-[-0.015em] [&_h1,&_h2,&_h3,&_h4]:text-[#1f2d45]",
  "[&_h1]:text-[22px] [&_h1]:leading-[1.35] [&_h2]:text-[18px] [&_h2]:leading-[1.45]",
  "[&_h3]:text-[15px] [&_h3]:leading-[1.5] [&_h4]:text-[14px] [&_h4]:leading-[1.55]",
  // ── 段落与长词换行（`wrap-anywhere` 覆盖 streamdown 的 `break-words`，同源语义）──
  "[&_p]:mt-0 [&_p]:mb-[0.85em]",
  "[&_p,&_li,&_blockquote,&_td,&_th,&_a]:wrap-anywhere [&_p,&_li,&_blockquote,&_td,&_th,&_a]:[word-break:normal]",
  // ── 列表：外边距/缩进取自 messages 分片（生效值），marker 与嵌套类型取自 ai-elements ──
  "[&_ul]:mt-[0.65em] [&_ul]:mb-[0.95em] [&_ul]:list-outside [&_ul]:list-disc [&_ul]:pl-[1.35rem]",
  "[&_ol]:mt-[0.65em] [&_ol]:mb-[0.95em] [&_ol]:list-outside [&_ol]:list-decimal [&_ol]:pl-[1.35rem]",
  "[&_ul_ul]:list-[circle] [&_ol_ol]:list-[lower-alpha]",
  "[&_li]:list-item [&_li]:my-[0.3em] [&_li]:pl-[0.1rem]",
  "[&_li::marker]:font-semibold [&_li::marker]:text-[#65758d]",
  "[&_li>ul,&_li>ol]:mt-[0.3em] [&_li>ul,&_li>ol]:mb-[0.25em]",
  // ── 引用（左侧缩进与边框按 messages 分片归零）──
  "[&_blockquote]:mt-[0.9em] [&_blockquote]:mb-[1em] [&_blockquote]:ml-0 [&_blockquote]:pl-0",
  "[&_blockquote]:pr-[0.8rem] [&_blockquote]:border-0 [&_blockquote]:bg-transparent",
  "[&_blockquote]:text-[#5f6e84] [&_blockquote]:italic",
  // ── 行内代码与代码块 ──
  "[&_:not(pre)>code]:rounded [&_:not(pre)>code]:border [&_:not(pre)>code]:border-[#e3e8ef]",
  "[&_:not(pre)>code]:bg-[#f7f7f7] [&_:not(pre)>code]:px-[0.34em] [&_:not(pre)>code]:py-[0.12em]",
  "[&_:not(pre)>code]:text-[0.9em] [&_:not(pre)>code]:text-[#4d5d75] [&_:not(pre)>code]:wrap-anywhere",
  "[&_pre]:mt-[0.8em] [&_pre]:mb-[1em] [&_pre]:max-w-full [&_pre]:overflow-x-auto",
  "[&_pre]:rounded-none [&_pre]:border-0 [&_pre]:bg-transparent",
  "[&_pre_code]:block [&_pre_code]:min-w-max [&_pre_code]:border-0 [&_pre_code]:bg-transparent",
  "[&_pre_code]:px-4 [&_pre_code]:py-[0.9rem] [&_pre_code]:whitespace-pre",
  "[&_pre_code]:wrap-normal [&_pre_code]:[word-break:normal]",
  // ── streamdown 的代码块外框与浮动操作条（原为两条全局规则 + 6 条容器内规则）──
  "[&_[data-streamdown=code-block]]:mt-[0.8em] [&_[data-streamdown=code-block]]:mb-[1em]",
  "[&_[data-streamdown=code-block]]:gap-0 [&_[data-streamdown=code-block]]:overflow-hidden",
  "[&_[data-streamdown=code-block]]:rounded-lg [&_[data-streamdown=code-block]]:border",
  "[&_[data-streamdown=code-block]]:border-[#e1e6ed] [&_[data-streamdown=code-block]]:bg-white",
  "[&_[data-streamdown=code-block]]:p-0",
  "[&_[data-streamdown=code-block-header]]:hidden [&_[data-streamdown=code-block-header]]:h-[30px]",
  "[&_[data-streamdown=code-block-header]]:border-b [&_[data-streamdown=code-block-header]]:border-[#edf0f4]",
  "[&_[data-streamdown=code-block-header]]:px-2",
  "[&_[data-streamdown=code-block-actions]]:gap-[2px] [&_[data-streamdown=code-block-actions]]:border-0",
  "[&_[data-streamdown=code-block-actions]]:bg-[rgb(255_255_255_/_88%)] [&_[data-streamdown=code-block-actions]]:shadow-none",
  "[&_[data-streamdown=code-block-actions]]:pointer-events-auto [&_[data-streamdown=mermaid-block-actions]]:pointer-events-auto",
  "[&_[data-streamdown=code-block-body]]:rounded-none [&_[data-streamdown=code-block-body]]:border-0",
  "[&_[data-streamdown=code-block-body]]:bg-transparent [&_[data-streamdown=code-block-body]]:p-0",
  "[&_[data-streamdown=code-block-body]_pre]:m-0",
  // ── 表格与媒体 ──
  "[&_table]:w-max [&_table]:min-w-full [&_table]:border-collapse [&_table]:bg-white [&_table]:text-[13px]",
  "[&_th,&_td]:border-b [&_th,&_td]:border-[#e5eaf1] [&_th,&_td]:px-[0.7rem] [&_th,&_td]:py-[0.55rem]",
  "[&_th,&_td]:text-left [&_th,&_td]:align-top",
  "[&_th]:font-[650] [&_th]:text-[#52627a]",
  "[&_table,&_img,&_video,&_iframe]:max-w-full",
  "[&_img]:mx-auto [&_img]:block [&_img]:h-auto",
  "[&_hr]:my-[1.4rem] [&_hr]:h-px [&_hr]:border-0 [&_hr]:bg-[#e5eaf1]",
].join(" ");
