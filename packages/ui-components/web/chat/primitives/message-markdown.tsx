/**
 * 消息正文的 Markdown 渲染边界：错误边界 + Suspense + 惰性 streamdown。
 *
 * 从 `message.tsx` 拆出：OpenUI 的围栏前后文本与失败回退都复用同一条 Markdown 路径，消息组件不再
 * 自己持有渲染器；文件行数也回到单模块上限内。
 */

import type { ComponentProps, ReactElement } from "react";
import { Component, lazy, Suspense } from "react";
import type { Components } from "streamdown";
import { cn } from "../../lib/cn";
import { MARKDOWN_CONTENT_CLASS } from "./internal/markdown-classes";

class StreamdownErrorBoundary extends Component<{ children: ReactElement; fallback?: string }, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch() {
    // 异常及组件栈可能携带正文，只记录稳定原因码。
    console.error("Streamdown failed to load: render-error");
  }
  render() {
    if (this.state.hasError) {
      // 兜底分支同样承载 `.chat-markdown-response` 的元素级声明（未分层 → 压过 `break-words`，按生效值写）。
      return (
        <div className="min-w-0 max-w-full whitespace-pre-wrap wrap-anywhere [word-break:normal]">
          {this.props.fallback}
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * 正文渲染器：streamdown 与**插件配置**一起在这条惰性边界上取。
 *
 * 为什么插件配置也要动态取：`MESSAGE_PLUGINS` 含数学插件，而数学插件静态拉起 `@streamdown/math` →
 * `rehype-katex` → KaTeX。若本模块静态引入它，KaTeX 会顺着 barrel 进入口 chunk（2026-10-15 实测到
 * `index.html` 里出现 `modulepreload katex-*.js`）；两者同源加载后，KaTeX 与 streamdown 一样只在
 * 真正渲染正文时才下载。
 */
const LazyStreamdown = lazy(async () => {
  const [streamdown, { MESSAGE_PLUGINS }] = await Promise.all([
    import("streamdown"),
    import("../primitives/message-plugins"),
  ]);
  const StreamdownWithPlugins = (props: ComponentProps<typeof streamdown.Streamdown>) => (
    <streamdown.Streamdown {...props} plugins={MESSAGE_PLUGINS} />
  );
  return { default: StreamdownWithPlugins };
});

/** `MessageMarkdown` 的入参：只传正文与渲染配置，重挂由调用方的 `key` 决定。 */
export interface MessageMarkdownProps {
  text: string;
  className?: string;
  mode: "static" | "streaming";
  isStreaming: boolean;
  allowedTags: Record<string, string[]>;
  components: Components;
  urlTransform: (url: string) => string;
}

/**
 * Markdown 正文的静态渲染边界：错误边界 + Suspense + 惰性 streamdown。
 *
 * OpenUI 失败回退与围栏前后的文本都经这里渲染，因此它必须保持轻量：不 import `openui-renderer`，
 * 也不在 Suspense 兜底里递归调用自身。
 */
export const MessageMarkdown = ({
  text,
  className,
  mode,
  isStreaming,
  allowedTags,
  components,
  urlTransform,
}: MessageMarkdownProps) => (
  <StreamdownErrorBoundary fallback={text}>
    <Suspense
      fallback={
        // 兜底分支沿用 `.chat-markdown-response` 的元素级声明（未分层 → 压过 `break-words`，按生效值写）。
        <div className={cn("min-w-0 max-w-full whitespace-pre-wrap wrap-anywhere [word-break:normal]", className)}>
          {text}
        </div>
      }
    >
      <LazyStreamdown
        allowedTags={allowedTags}
        components={components}
        urlTransform={urlTransform}
        mode={mode}
        isAnimating={isStreaming}
        // markdown 排版（标题/列表/引用/代码块/表格与 streamdown 内部 DOM）全部挂在容器上：
        // 这些节点由 streamdown 自己渲染，本包只能给容器——见 `./internal/markdown-classes`。
        // 说明：streamdown 的根节点只接收它自己的 props（未知属性不落到 DOM），所以 markdown
        // 容器无法挂 `data-slot`；对它的结构断言由 markdown 元素上的 `data-streamdown="…"` 承担。
        // 只占满宽度：OpenUI 会把一条消息拆成「前文 / 面板 / 后文」三个兄弟片段，
        // 高度 100% 会让每个片段各自撑满容器，把后续片段顶出视口。
        className={cn(MARKDOWN_CONTENT_CLASS, "message-response w-full", className)}
      >
        {text}
      </LazyStreamdown>
    </Suspense>
  </StreamdownErrorBoundary>
);
