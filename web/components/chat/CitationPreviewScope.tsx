"use client";

import { type ReactNode, type RefObject, useCallback, useEffect, useMemo, useState } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import {
  CITATION_PREVIEW_WIDTH_RATIO,
  type CitationPreview,
  CitationPreviewContext,
} from "@/src/lib/citation-preview-context";
import { CitationPreviewPanel } from "./CitationPreviewPanel";

interface CitationPreviewScopeProps {
  /**
   * 右侧站点/文件面板的 imperative handle（来自 usePanelRef）。
   * 引用预览打开时折叠它，避免 overlay 与面板重叠；关闭时不自动展开（用户手动 toggle 恢复）。
   * 可选：无面板的场景（如 FaqDialog / MetaAgent）不传，仅弹 overlay。
   */
  artifactsPanelRef?: RefObject<PanelImperativeHandle | null>;
  children: ReactNode;
}

/**
 * 引用预览作用域：管理预览状态、经 Context 下发给深层 CitationLink / ChatInterface，
 * 在布局顶层渲染 overlay，并在打开时联动折叠右侧面板。
 *
 * 设计原因见 citation-preview-context.tsx：原先 CitationLink 自带 overlay + 模块级事件总线
 * 通知布局层，存在「布局层监听挂错组件」「HMR 单例失配」两个问题。改为状态提升 + Context 后，
 * 各聊天入口用此组件包裹即可获得引用预览能力，避免在每个路由/面板重复状态 + effect + overlay。
 */
export function CitationPreviewScope({ artifactsPanelRef, children }: CitationPreviewScopeProps) {
  const [citationPreview, setCitationPreview] = useState<CitationPreview | null>(null);

  const openCitation = useCallback((resourceId: string, kbId: string) => {
    setCitationPreview({
      resourceId,
      kbId,
      width: Math.round(window.innerWidth * CITATION_PREVIEW_WIDTH_RATIO),
    });
  }, []);

  const closeCitation = useCallback(() => setCitationPreview(null), []);

  const ctxValue = useMemo(
    () => ({ preview: citationPreview, openCitation, closeCitation }),
    [citationPreview, openCitation, closeCitation],
  );

  // 引用预览打开时折叠右侧站点/文件面板，避免 overlay 与面板重叠。
  // artifactsPanelRef 是 usePanelRef() 返回的稳定 RefObject，放入依赖不影响稳定性。
  useEffect(() => {
    if (citationPreview) {
      artifactsPanelRef?.current?.collapse();
    }
  }, [citationPreview, artifactsPanelRef]);

  return (
    <CitationPreviewContext.Provider value={ctxValue}>
      {children}
      {/* overlay 渲染在布局顶层而非 markdown <p> 内，避免浏览器自动闭合 <p> 破坏 DOM 结构 */}
      {citationPreview && (
        <div
          className="fixed inset-y-0 right-0 z-50 flex flex-col bg-background border-l shadow-2xl"
          style={{ width: citationPreview.width }}
        >
          <CitationPreviewPanel
            resourceId={citationPreview.resourceId}
            kbId={citationPreview.kbId}
            onClose={closeCitation}
          />
        </div>
      )}
    </CitationPreviewContext.Provider>
  );
}
