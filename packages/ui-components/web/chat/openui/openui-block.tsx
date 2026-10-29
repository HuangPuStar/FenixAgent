/**
 * OpenUI 块的静态入口：动作接线 + 懒加载边界。
 *
 * 本文件是**轻量静态模块**，不得静态 import `./openui-renderer`（它含 parser 与图表），也不能
 * 静态引 streamdown 的值导出——正文回退经调用方注入的 `renderText` 完成。
 */

import type { OpenUIDocument } from "@peri-code/sdk/openui";
import { Component, lazy, type ReactNode, Suspense } from "react";
import { useOpenUIAction } from "./action-context";

const LazyOpenUIRenderer = lazy(() => import("./openui-renderer"));

/** 懒加载兜底沿用消息正文的原始文本排版（与 `MessageResponse` 的 Suspense 兜底同一组类）。 */
const FALLBACK_TEXT_CLASS = "min-w-0 max-w-full whitespace-pre-wrap wrap-anywhere [word-break:normal]";

export interface OpenUIChunkErrorBoundaryProps {
  children: ReactNode;
  /** 失败时展示的内容，通常是原始正文。 */
  fallback: ReactNode;
  /** 程序变化时重置错误态。 */
  resetKey?: string;
}

/**
 * 懒加载 chunk 的同步错误边界。
 *
 * `React.lazy` 的 import 失败发生在 chunk 求值期，`OpenUIErrorBoundary` 位于该 chunk 内部，
 * 那时还没挂载，捕获不到；因此这一层必须留在静态图里，否则错误会穿到消息级边界并打断整条正文。
 */
export class OpenUIChunkErrorBoundary extends Component<OpenUIChunkErrorBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    // 异常与组件栈可能携带正文，只记录稳定原因码（同 `StreamdownErrorBoundary`）。
    console.error("OpenUI renderer chunk failed: chunk-load-error");
  }

  componentDidUpdate(previous: OpenUIChunkErrorBoundaryProps) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  render() {
    if (this.state.failed) {
      return <div data-openui-fallback="chunk-load-error">{this.props.fallback}</div>;
    }
    return this.props.children;
  }
}

export interface OpenUIBlockProps {
  document: OpenUIDocument;
  /** 整条消息原文：解析失败或渲染异常时完整回退，不丢模型输出。 */
  fallbackText: string;
  isStreaming: boolean;
  /** 宿主正文渲染器（通常是 Markdown），用于围栏前后的文本与回退。 */
  renderText: (text: string) => ReactNode;
}

export function OpenUIBlock({ document, fallbackText, isStreaming, renderText }: OpenUIBlockProps) {
  const handler = useOpenUIAction();
  const program = document.program;

  // 调用方（`MessageResponse`）只在 `program !== null` 时挂载本组件；保留防御分支避免类型收窄扩散。
  if (program === null) return null;

  const rawFallback = <div className={FALLBACK_TEXT_CLASS}>{fallbackText}</div>;

  return (
    <OpenUIChunkErrorBoundary fallback={rawFallback} resetKey={program}>
      <Suspense fallback={rawFallback}>
        <LazyOpenUIRenderer
          actionsEnabled={handler?.enabled ?? false}
          after={document.after}
          before={document.before}
          fallback={renderText(fallbackText)}
          fallbackText={fallbackText}
          isStreaming={isStreaming}
          onAction={handler?.enabled ? handler.send : undefined}
          program={program}
          renderText={renderText}
          resetKey={program}
        />
      </Suspense>
    </OpenUIChunkErrorBoundary>
  );
}
