/**
 * 文档类预览容器（markdown / `.tex`）：统一承担状态边界与「渲染 / 源码」切换，渲染本身交给各自的渲染器。
 *
 * 分工：
 * - markdown 的渲染模式**直接用既有预览器**（`markdownView`，即宿主传入的 `FileViewer`，数学渲染由
 *   `markdown-math-plugin` 在既有 markdown 渲染链上加了一层 KaTeX）；源码模式在这里用 `<pre>` 呈现。
 * - LaTeX 的渲染模式用 `latex-content.tsx`（`React.lazy` 动态导入：KaTeX 只在真正预览 `.tex` 时加载）。
 * - 两种模式都需要正文文本时才解码（markdown 渲染模式由预览器自己读 Blob，不重复解码）。
 *
 * 状态边界（前端规范 §「页面流程必须覆盖 loading / empty / error」）：
 * 空文件（0 字节）在解码前就能判定；超过 `PREVIEW_MAX_DOCUMENT_BYTES` 时只提供源码展示并给出说明——
 * 文档渲染是整篇同步解析，硬渲染大文件只会让面板长时间无响应；解码失败复用预览链既有的
 * 「加载失败 + 重试」文案与出口，不另造一套。
 */

import { lazy, type ReactNode, Suspense, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import { cn } from "../../lib/cn";
import { Spinner } from "../../ui/spinner";
import { type DocumentCategory, decodePreviewText, shouldRenderDocumentContent } from "./preview-source";

/** 按需加载：KaTeX（JS + 字体样式表）不进预览面板的首屏静态图。 */
const LazyLatexPreview = lazy(async () => {
  const module = await import("./latex-content");
  return { default: module.LatexPreview };
});

type PreviewMode = "render" | "source";

export interface DocumentPreviewProps {
  /** 文档类别：markdown 走既有预览器，latex 走 `latex-content.tsx`。 */
  kind: DocumentCategory;
  /** 文件字节（文档类预览一律按 Blob 加载，见 `shouldLoadPreviewAsBlob`）。 */
  blob: Blob;
  /** markdown 渲染模式的既有预览器；latex 不使用（传进来也不会挂载）。 */
  markdownView: ReactNode;
}

/**
 * 文档类预览容器。调用方负责取数（加载中 / 取数失败在上层处理），这里只处理拿到字节之后的状态。
 */
export function DocumentPreview({ kind, blob, markdownView }: DocumentPreviewProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const renderable = shouldRenderDocumentContent(blob.size);
  const [mode, setMode] = useState<PreviewMode>(renderable ? "render" : "source");
  const [text, setText] = useState<string | null>(null);
  const [decodeFailed, setDecodeFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // 两个标签与内容区共用一对 id：`aria-controls` / `aria-labelledby` 的关联必须成套，否则标签语义不完整
  const panelId = useId();
  const renderTabId = `${panelId}-render`;
  const sourceTabId = `${panelId}-source`;
  // markdown 的渲染模式由预览器自己读 Blob；其余分支都要正文
  const needsText = mode === "source" || kind === "latex";

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey 是刻意的重触发信号（解码失败后点重试重新解码），规则看不到「依赖变化即重跑」的意图；移除它会丢掉重试语义。
  useEffect(() => {
    if (!needsText) return;
    let cancelled = false;
    setText(null);
    setDecodeFailed(false);
    void decodePreviewText(blob)
      .then((value) => {
        if (!cancelled) setText(value);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error("[DocumentPreview] 文档正文解码失败", error);
        setDecodeFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [blob, needsText, reloadKey]);

  if (blob.size === 0) {
    return <StateMessage>{t("fileTree.preview.emptyFile")}</StateMessage>;
  }

  if (decodeFailed) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4" role="alert">
        <span className="text-xs font-medium text-red-500">{t("fileTree.preview.loadFailedUnknown")}</span>
        <button
          type="button"
          className="text-xs text-primary hover:underline"
          onClick={() => setReloadKey((key) => key + 1)}
        >
          {t("fileTree.preview.retry")}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1" role="tablist">
        <TabButton
          active={mode === "render"}
          controls={panelId}
          disabled={!renderable}
          id={renderTabId}
          label={t("fileTree.preview.renderTab")}
          onClick={() => setMode("render")}
        />
        <TabButton
          active={mode === "source"}
          controls={panelId}
          id={sourceTabId}
          label={t("fileTree.preview.sourceTab")}
          onClick={() => setMode("source")}
        />
        {!renderable && <span className="ml-auto text-xs text-text-muted">{t("fileTree.preview.tooLarge")}</span>}
      </div>
      {/* 两个标签共用同一块内容区：`aria-labelledby` 指向当前选中的那个标签 */}
      <div
        id={panelId}
        role="tabpanel"
        aria-labelledby={mode === "render" ? renderTabId : sourceTabId}
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        {mode === "render" && kind === "markdown" ? (
          // 既有预览器自带滚动容器（fit / 缩放由它管理），这里只给高度
          <div className="flex min-h-0 flex-1 flex-col">{markdownView}</div>
        ) : text === null ? (
          <div className="flex flex-1 items-center justify-center p-4" role="status">
            <Spinner size="sm" />
          </div>
        ) : mode === "render" ? (
          <div className="flex-1 overflow-auto p-3">
            <Suspense
              fallback={
                <div className="flex items-center justify-center p-4" role="status">
                  <Spinner size="sm" />
                </div>
              }
            >
              <LazyLatexPreview text={text} />
            </Suspense>
          </div>
        ) : (
          <pre className="flex-1 overflow-auto p-3 font-mono text-xs leading-relaxed whitespace-pre text-text-primary">
            {text}
          </pre>
        )}
      </div>
    </div>
  );
}

function TabButton({
  active,
  controls,
  disabled,
  id,
  label,
  onClick,
}: {
  active: boolean;
  controls: string;
  disabled?: boolean;
  id: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      id={id}
      aria-controls={controls}
      aria-selected={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "rounded-sm px-2 py-0.5 text-xs transition-colors",
        active ? "bg-surface-2 text-text-primary" : "text-text-muted hover:text-text-primary",
        "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-text-muted",
      )}
    >
      {label}
    </button>
  );
}

function StateMessage({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center p-4">
      <p className="text-xs text-text-muted">{children}</p>
    </div>
  );
}
