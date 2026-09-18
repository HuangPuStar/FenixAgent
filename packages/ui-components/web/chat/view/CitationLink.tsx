"use client";

import { BookOpen } from "lucide-react";
import { type ReactNode, useCallback } from "react";

interface CitationLinkProps {
  resourceId: string;
  kbId: string;
  children: ReactNode;
  /** 打开引用预览；由宿主注入（源实现走宿主 CitationPreviewContext）。未注入时点击为无操作。 */
  onOpen?: (resourceId: string, kbId: string) => void;
  /** 悬停提示，默认与源实现的中文字面量一致。 */
  title?: string;
}

/**
 * 知识库引用可点击链接。
 *
 * 复制自 `packages/agent-runtime/web/components/chat/CitationLink.tsx`。
 * 纯化改动点：
 * - 移除宿主 `@/src/lib/citation-preview-context` 依赖：打开预览改为 `onOpen` 回调 prop，
 *   预览面板的渲染与布局联动仍由宿主负责。
 * - 硬编码中文 `title` 提为可选 prop，默认值与源字面量逐字一致。
 *
 * 保留的源设计约束：只渲染一个 `<span>`，不在此处渲染 overlay `<div>` —— 本组件出现在
 * streamdown 渲染的 markdown `<p>` 内，若内嵌 `<div>` 会被浏览器自动闭合 `<p>` 破坏 DOM 结构。
 */
export function CitationLink({ resourceId, kbId, children, onOpen, title = "点击预览引用文档" }: CitationLinkProps) {
  const handleOpen = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      onOpen?.(resourceId, kbId);
    },
    [onOpen, resourceId, kbId],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onOpen?.(resourceId, kbId);
      }
    },
    [onOpen, resourceId, kbId],
  );

  return (
    <span
      role="link"
      tabIndex={0}
      onClick={handleOpen}
      onKeyDown={handleKeyDown}
      className="inline-flex items-center gap-1 text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary cursor-pointer"
      title={title}
    >
      <BookOpen className="h-3.5 w-3.5 inline" />
      {children}
    </span>
  );
}
