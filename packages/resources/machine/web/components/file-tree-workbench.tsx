import { cn } from "@fenix/ui-components/lib/cn";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@fenix/ui-components/ui/resizable";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
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

/** 浮动形态：树从布局里退出（面板宽度 0），改由绝对定位盖在预览之上。 */
const EXPLORER_OVERLAY_CLASS = "absolute inset-y-0 left-0 z-20 border-r border-border-subtle shadow-xl";

interface FileTreeWorkbenchProps {
  layout: FileTreeLayoutMode;
  /** 文件树节点。两种模式共用同一个 React 位置——切模式只重排几何，不重建子树。 */
  tree: ReactNode;
  /** 预览列（tab 栏 + 预览 tab）。浮层与切换按钮都不改它的挂载与盒模型。 */
  preview: ReactNode;
  /** 固定列的初始宽度（`fenix:file-tree-width` 的偏好值）。 */
  initialTreeWidth: number;
  /** 拖动改宽；持久化归调用方（写 `fenix:file-tree-width`）。 */
  onTreeWidthChange: (width: number) => void;
  /** 浮动模式下树是否展开（收起时只留切换按钮，预览占满整宽）。 */
  treeOpen: boolean;
  /** 浮动模式下的显示 / 隐藏切换。 */
  onToggleTree: () => void;
}

/**
 * 文件工作台的几何层：`docked` 保留 VS Code 式两列（文件树列 + 预览列，拖动手柄改宽），
 * `floating` 下预览占满整宽、文件树以浮层盖在预览左缘。
 *
 * **结构只有一份、两种模式共用**（这一点是刻意的）：预览与文件树在 React 树里的位置不随模式变化，
 * 因此切模式不会重建任何一侧的子树——预览不重新取数、不丢滚动位置，树的展开态与搜索词也留得住。
 * 浮动模式靠「把树面板在布局上收到 0 宽 + 内容改绝对定位」实现，而不是换成另一棵 JSX：
 * - 面板的 `className`/`style` 由库落在**内层 div** 上（`PanelProps` 的类型注释），所以浮层几何写在这里；
 * - 浮层相对最近的定位祖先（本组件的 `relative` 根）定位，库给面板外层留的是 `overflow: visible`；
 * - 收起态只加 `invisible`（不卸载）：树保持在册，展开态、已加载的树数据与 react-arborist 的量高结果都不丢。
 *
 * 宽度只写在 `ref` 里：拖动改宽每帧都会触发，进 `state` 会让文件树与预览两棵子树跟着重渲染。
 */
export function FileTreeWorkbench({
  layout,
  tree,
  preview,
  initialTreeWidth,
  onTreeWidthChange,
  treeOpen,
  onToggleTree,
}: FileTreeWorkbenchProps) {
  const { t } = useTranslation(MACHINE_NS);
  const panelGroupRef = useRef<HTMLDivElement>(null);
  const fileTreePanelRef = useRef<PanelImperativeHandle>(null);
  const treeWidthRef = useRef(initialTreeWidth);

  const isFloating = layout === "floating";
  const showOverlay = isFloating && treeOpen;
  // 浮层宽度取固定模式的同一份宽度偏好，夹在最小宽度与上限之间（见 lib/file-tree-layout.ts）。
  const overlayWidth = clampFileTreeOverlayWidth(treeWidthRef.current);

  // react-resizable-panels v4 在父 Group 缩放时会按比例重算 layout，且该路径不会重新应用
  // panel 的 min/max 约束。外侧右栏变化后主动校正，确保文件树始终处于 176px..50%。
  // 依赖 `layout`：浮动模式下树列不占宽，切回固定时这段订阅必须重新挂上（挂载时只跑一次的写法会漏）。
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

  // 浮动：树列收到 0 宽（内容由绝对定位的浮层承载）；固定：回到偏好宽度。
  // 两侧都走 `resize()`，尺寸受各自模式的 min/max 约束——固定模式的约束与拖动行为保持原样。
  useEffect(() => {
    const panel = fileTreePanelRef.current;
    if (!panel) return;
    panel.resize(isFloating ? "0px" : `${treeWidthRef.current}px`);
  }, [isFloating]);

  const previewColumn = <div className="h-full min-h-0 min-w-0 flex flex-col">{preview}</div>;

  return (
    <div className="relative flex-1 min-h-0 min-w-0" data-tree-layout={layout}>
      <ResizablePanelGroup orientation="horizontal">
        <ResizablePanel
          panelRef={fileTreePanelRef}
          defaultSize={isFloating ? "0px" : `${treeWidthRef.current}px`}
          minSize={isFloating ? "0px" : `${FILE_TREE_MIN_WIDTH}px`}
          maxSize={isFloating ? "0px" : "50%"}
          groupResizeBehavior="preserve-pixel-size"
          // 浮层契约：只有「浮动且展开」时这块面板才是盖在预览上的浮层（收起时只留 0 宽占位）。
          data-slot={showOverlay ? "file-tree-overlay" : undefined}
          // 收起态用 `invisible` 而不是 `hidden`：盒子留着（react-arborist 才能量到高度，展开时不必等下一次
          // resize 才补渲），但既不绘制也不吃指针事件；`visibility: hidden` 同时移出无障碍树。
          className={cn(isFloating && EXPLORER_OVERLAY_CLASS, isFloating && !treeOpen && "invisible")}
          style={isFloating ? { maxWidth: "none", overflow: "hidden", width: overlayWidth } : undefined}
          onResize={(size) => {
            // 浮动模式下的尺寸变化（收起到 0 / 展开）不是用户的宽度意图，不得覆盖偏好值。
            if (isFloating) return;
            if (size.inPixels == null || !Number.isFinite(size.inPixels)) return;
            const width = Math.max(FILE_TREE_MIN_WIDTH, size.inPixels);
            treeWidthRef.current = width;
            onTreeWidthChange(width);
          }}
        >
          <div className={EXPLORER_CLASS}>{tree}</div>
        </ResizablePanel>
        {/* 分隔条在浮动模式下没有意义（树列 0 宽），用 `hidden` 收起而不是卸载：group 的子节点集合保持恒定。 */}
        <ResizableHandle className={cn(isFloating ? "hidden" : "artifacts-workbench-divider bg-border-subtle")} />
        <ResizablePanel minSize={`${PREVIEW_MIN_WIDTH}px`}>{previewColumn}</ResizablePanel>
      </ResizablePanelGroup>
      {isFloating && (
        // 盖在预览之上的常驻切换按钮：贴着「树列 / 预览」当前的分界线（展开时随浮层右缘，收起时贴工作台左缘），
        // 竖向居中——预览自身的工具栏在底部（`preview/overrides.css` 的 column-reverse），不会被它压到。
        <button
          type="button"
          data-slot="file-tree-overlay-toggle"
          className="absolute top-1/2 z-30 grid h-12 w-7.5 -translate-y-1/2 place-items-center rounded-r border border-border-subtle border-l-0 bg-surface-1 text-text-muted shadow-md hover:text-brand focus-visible:text-brand"
          style={{ left: showOverlay ? overlayWidth : 0 }}
          onClick={onToggleTree}
          title={treeOpen ? t("fileTree.layout.close") : t("fileTree.layout.open")}
          aria-label={treeOpen ? t("fileTree.layout.close") : t("fileTree.layout.open")}
          aria-expanded={treeOpen}
        >
          {treeOpen ? (
            <PanelLeftClose className="size-4" aria-hidden />
          ) : (
            <PanelLeftOpen className="size-4" aria-hidden />
          )}
        </button>
      )}
    </div>
  );
}
