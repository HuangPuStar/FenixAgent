"use client";

import { BookOpen } from "lucide-react";
import { useCallback } from "react";
import { useCitationPreview } from "@/src/lib/citation-preview-context";

interface CitationLinkProps {
  resourceId: string;
  kbId: string;
  children: React.ReactNode;
}

/**
 * 知识库引用可点击链接。
 *
 * 点击通过 CitationPreviewContext 通知布局层（ChatRoute）打开右侧 overlay 预览，
 * 布局层负责渲染预览面板、推动对话区、折叠站点工作区。
 *
 * 只渲染一个 <span>，不在此处渲染 overlay <div>：本组件出现在 streamdown 渲染的
 * markdown <p> 内，若内嵌 <div> 会被浏览器自动闭合 <p> 破坏 DOM 结构。overlay 由
 * ChatRoute 在布局顶层渲染，规避该问题。
 */
export function CitationLink({ resourceId, kbId, children }: CitationLinkProps) {
  const { openCitation } = useCitationPreview();

  const handleOpen = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      openCitation(resourceId, kbId);
    },
    [openCitation, resourceId, kbId],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openCitation(resourceId, kbId);
      }
    },
    [openCitation, resourceId, kbId],
  );

  return (
    <span
      role="link"
      tabIndex={0}
      onClick={handleOpen}
      onKeyDown={handleKeyDown}
      className="inline-flex items-center gap-1 text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary cursor-pointer"
      title="点击预览引用文档"
    >
      <BookOpen className="h-3.5 w-3.5 inline" />
      {children}
    </span>
  );
}
