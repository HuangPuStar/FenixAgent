import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@fenix/ui-components/ui/resizable";
import { PanelLeft } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { PanelImperativeHandle } from "react-resizable-panels";

import { MACHINE_NS } from "../i18n/namespace";
import { clampFileTreeOverlayWidth, FILE_TREE_MIN_WIDTH, type FileTreeLayoutMode } from "../lib/file-tree-layout";

const PREVIEW_MIN_WIDTH = 160;

/**
 * 文件树一列的底色：原 `artifacts-files-workspace.css`（伴随表，2026-09-28 第四波随最后一条声明撤回而删除）
 * 里的 `background: #fbfcff`，按色阶口径归一到最近档 `slate-50`（#f8fafc，ΔE2000 = 0.94，肉眼不可辨；
 * 与 `--color-surface-0` 同值，取色阶类与同批其他页一致）。固定列与浮层共用同一底色，`artifacts-explorer`
 * 留作语义钩子。
 */
const EXPLORER_CLASS = "artifacts-explorer h-full min-h-0 flex flex-col overflow-hidden bg-slate-50";

interface FileTreeWorkbenchProps {
  layout: FileTreeLayoutMode;
  /** 文件树节点。两种模式共用同一份实例——切模式只是一次重渲染，不是两棵树。 */
  tree: ReactNode;
  /** 预览列（tab 栏 + 预览 tab）。浮层只改几何，不改它的挂载。 */
  preview: ReactNode;
  /** 固定列的初始宽度（`fenix:file-tree-width` 的偏好值）。 */
  initialTreeWidth: number;
  /** 拖动改宽；持久化归调用方（写 `fenix:file-tree-width`）。 */
  onTreeWidthChange: (width: number) => void;
  /** 浮动模式下浮层是否打开；关闭后由左缘常驻按钮重开。 */
  overlayOpen: boolean;
  onOpenOverlay: () => void;
}

/**
 * 文件工作台的几何层：`docked` 保留 VS Code 式两列（文件树列 + 预览列，拖动手柄改宽），
 * `floating` 让预览占满整个工作台、文件树以浮层盖在其上（不占布局宽度）。
 *
 * 宽度只写在 `ref` 里：拖动改宽每帧都会触发，进 `state` 会让文件树与预览两棵子树跟着重渲染。
 * 浮层宽度取同一份宽度偏好并夹在 `FILE_TREE_OVERLAY_MAX_WIDTH` 之内（见 `lib/file-tree-layout.ts`）。
 *
 * 已知代价：两种几何的父链不同，React 按位置对账，因此切换模式会重建文件树子树——展开态与搜索词丢失，
 * 并触发一次树刷新（预览一侧的 tab / 选中文件在面板层，不受影响）。要消除它就得把展开态从
 * `FileTreeTab` 提出去，或改成「面板宽度压到 0 + 内容绝对定位」的单一结构；两者都超出本次范围。
 */
export function FileTreeWorkbench({
  layout,
  tree,
  preview,
  initialTreeWidth,
  onTreeWidthChange,
  overlayOpen,
  onOpenOverlay,
}: FileTreeWorkbenchProps) {
  const { t } = useTranslation(MACHINE_NS);
  const panelGroupRef = useRef<HTMLDivElement>(null);
  const fileTreePanelRef = useRef<PanelImperativeHandle>(null);
  const treeWidthRef = useRef(initialTreeWidth);

  // react-resizable-panels v4 在父 Group 缩放时会按比例重算 layout，且该路径不会重新应用
  // panel 的 min/max 约束。外侧右栏变化后主动校正，确保文件树始终处于 176px..50%。
  // 依赖 `layout`：浮动模式下没有 group，切回固定时这段订阅必须重新挂上（挂载时只跑一次的写法会漏）。
  useEffect(() => {
    if (layout !== "docked") return;
    const panelGroup = panelGroupRef.current;
    if (!panelGroup) return;

    let animationFrame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => {
        const panel = fileTreePanelRef.current;
        if (!panel) return;

        const groupWidth = panelGroup.clientWidth;
        const currentWidth = panel.getSize().inPixels;
        const maxWidth = groupWidth * 0.5;
        const nextWidth = Math.max(FILE_TREE_MIN_WIDTH, Math.min(currentWidth, maxWidth));
        if (Math.abs(currentWidth - nextWidth) >= 1) panel.resize(`${nextWidth}px`);
      });
    });
    observer.observe(panelGroup);

    return () => {
      observer.disconnect();
      cancelAnimationFrame(animationFrame);
    };
  }, [layout]);

  const previewColumn = <div className="h-full min-h-0 min-w-0 flex flex-col">{preview}</div>;

  if (layout === "floating") {
    return (
      <div className="relative flex-1 min-h-0 min-w-0" data-tree-layout="floating">
        {previewColumn}
        {overlayOpen ? (
          <div
            data-slot="file-tree-overlay"
            className={`${EXPLORER_CLASS} absolute inset-y-0 left-0 z-20 border-r border-border-subtle shadow-xl`}
            style={{ width: clampFileTreeOverlayWidth(treeWidthRef.current) }}
          >
            {tree}
          </div>
        ) : (
          // 浮层关闭后的重开入口：贴预览区左缘的常驻按钮，几何与宿主右栏的展开按钮镜像。
          <button
            type="button"
            data-slot="file-tree-overlay-open"
            className="absolute top-1/2 left-0 z-20 grid h-12 w-7.5 -translate-y-1/2 place-items-center rounded-r border border-border-subtle border-l-0 bg-surface-1 text-text-muted shadow-md hover:text-brand focus-visible:text-brand"
            onClick={onOpenOverlay}
            title={t("fileTree.layout.open")}
            aria-label={t("fileTree.layout.open")}
          >
            <PanelLeft className="size-4" aria-hidden />
          </button>
        )}
      </div>
    );
  }

  return (
    <div ref={panelGroupRef} className="flex-1 min-h-0 min-w-0" data-tree-layout="docked">
      <ResizablePanelGroup orientation="horizontal">
        <ResizablePanel
          panelRef={fileTreePanelRef}
          defaultSize={`${treeWidthRef.current}px`}
          minSize={`${FILE_TREE_MIN_WIDTH}px`}
          maxSize="50%"
          groupResizeBehavior="preserve-pixel-size"
          onResize={(size) => {
            if (size.inPixels == null || !Number.isFinite(size.inPixels)) return;
            const width = Math.max(FILE_TREE_MIN_WIDTH, size.inPixels);
            treeWidthRef.current = width;
            onTreeWidthChange(width);
          }}
        >
          <div className={EXPLORER_CLASS}>{tree}</div>
        </ResizablePanel>
        <ResizableHandle className="artifacts-workbench-divider bg-border-subtle" />
        <ResizablePanel minSize={`${PREVIEW_MIN_WIDTH}px`}>{previewColumn}</ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
