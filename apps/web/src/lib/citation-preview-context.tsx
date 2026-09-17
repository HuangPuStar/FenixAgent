import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";

/**
 * 引用预览宽度占视口的比例（与历史 overlay 行为保持一致）。
 */
export const CITATION_PREVIEW_WIDTH_RATIO = 0.4;

export interface CitationPreview {
  resourceId: string;
  kbId: string;
  /** overlay 宽度（px），打开时按视口宽度计算 */
  width: number;
}

interface CitationPreviewContextValue {
  /** 当前打开的引用预览，null 表示未打开 */
  preview: CitationPreview | null;
  /** 打开引用预览（由 CitationLink 点击触发） */
  openCitation: (resourceId: string, kbId: string) => void;
  /** 关闭引用预览 */
  closeCitation: () => void;
}

/**
 * 引用预览状态上下文。
 *
 * 设计原因：原先 CitationLink 与布局层（ChatRoute / ChatInterface）通过模块级事件总线
 * `citation-bus.ts` 通信，存在两个致命问题：
 * 1. 布局层监听曾错挂在从未被挂载的 AgentAppShell 上，effect 永远不执行；
 * 2. Vite HMR 下编辑该 bus 模块会重新求值产生新的 singleton，而 React 组件 [] 依赖的
 *    effect 仍持有旧引用，导致 emitOpen 永远到达不了 listener。
 *
 * 改用 Context 后，预览状态完全由 React 管理：ChatRoute（真正的布局壳）持有状态并
 * 通过 Provider 下发，CitationLink / ChatInterface 作为子孙消费。无单例、无 HMR 失配、
 * 无跨组件事件时序问题。
 */
export const CitationPreviewContext = createContext<CitationPreviewContextValue | null>(null);

/** 无 Provider 时的安全兜底，确保 CitationLink 在 Provider 外渲染也不会崩溃（功能不可用但不报错） */
const NOOP_CITATION: CitationPreviewContextValue = {
  preview: null,
  openCitation: () => {},
  closeCitation: () => {},
};

/**
 * 消费引用预览状态。必须在 ChatRoute 提供的 Provider 内使用；Provider 外调用返回
 * 安全兜底（preview 恒为 null，open/close 为空操作），避免深层 markdown 渲染崩溃。
 */
export function useCitationPreview(): CitationPreviewContextValue {
  return useContext(CitationPreviewContext) ?? NOOP_CITATION;
}

/**
 * 可选的受控 Provider：当消费方不需要直接读取 preview（如仅需在子树提供 open/close 能力）
 * 时使用。ChatRoute 因需直接读取 preview 渲染 overlay 并联动折叠，直接用
 * `CitationPreviewContext.Provider` 传值，不经过此组件。
 */
export function CitationPreviewProvider({ children }: { children: ReactNode }) {
  const [preview, setPreview] = useState<CitationPreview | null>(null);

  const openCitation = useCallback((resourceId: string, kbId: string) => {
    setPreview({ resourceId, kbId, width: Math.round(window.innerWidth * CITATION_PREVIEW_WIDTH_RATIO) });
  }, []);

  const closeCitation = useCallback(() => setPreview(null), []);

  const value = useMemo<CitationPreviewContextValue>(
    () => ({ preview, openCitation, closeCitation }),
    [preview, openCitation, closeCitation],
  );

  return <CitationPreviewContext.Provider value={value}>{children}</CitationPreviewContext.Provider>;
}
