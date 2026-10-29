/**
 * OpenUI 块的静态入口：动作接线 + 懒加载边界。
 *
 * 本文件是**轻量静态模块**，不得静态 import `./openui-renderer`（它含 parser 与图表），也不能
 * 静态引 streamdown 的值导出——正文回退经调用方注入的 `renderText` 完成。
 */

import type { OpenUIDocument } from "@peri-code/sdk/openui";
import { lazy, type ReactNode, Suspense } from "react";
import { useOpenUIAction } from "./action-context";

const LazyOpenUIRenderer = lazy(() => import("./openui-renderer"));

/** 懒加载兜底沿用消息正文的原始文本排版（与 `MessageResponse` 的 Suspense 兜底同一组类）。 */
const FALLBACK_TEXT_CLASS = "min-w-0 max-w-full whitespace-pre-wrap wrap-anywhere [word-break:normal]";

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

  return (
    <Suspense fallback={<div className={FALLBACK_TEXT_CLASS}>{fallbackText}</div>}>
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
  );
}
