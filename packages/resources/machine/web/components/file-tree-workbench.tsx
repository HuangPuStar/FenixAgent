import { Button } from "@fenix/ui-components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@fenix/ui-components/ui/resizable";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { type MouseEvent, type ReactNode, useCallback, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { MACHINE_NS } from "../i18n/namespace";

const FILE_TREE_WIDTH_KEY = "fenix:file-tree-width";
const FILE_TREE_MIN_WIDTH = 176;
const FILE_TREE_DEFAULT_WIDTH = 184;
const FILE_TREE_MAX_PERCENT = 50;
const PREVIEW_MIN_WIDTH = 160;

function readFileTreeWidth(): number {
  try {
    const width = Number(localStorage.getItem(FILE_TREE_WIDTH_KEY));
    return Number.isFinite(width) && width >= FILE_TREE_MIN_WIDTH ? width : FILE_TREE_DEFAULT_WIDTH;
  } catch {
    return FILE_TREE_DEFAULT_WIDTH;
  }
}

interface FileTreeWorkbenchProps {
  /** 文件树及其标题栏中的收起入口。 */
  renderTree: (collapseAction: ReactNode) => ReactNode;
  /** 预览及其标签栏中的展开入口。 */
  renderPreview: (expandAction: ReactNode) => ReactNode;
}

/** 开合只调整分栏宽度，文件树、预览和编辑器留在原来的挂载位置。 */
export function FileTreeWorkbench({ renderTree, renderPreview }: FileTreeWorkbenchProps) {
  const { t } = useTranslation(MACHINE_NS);
  const treeId = useId();
  const fileTreePanel = useRef<PanelImperativeHandle>(null);
  const [treeOpen, setTreeOpen] = useState(true);
  const [initialWidth] = useState(readFileTreeWidth);
  const expandedWidth = useRef(initialWidth);
  const focusNextAction = useRef(false);
  const focusAction = useCallback((button: HTMLButtonElement | null) => {
    if (button && focusNextAction.current) {
      focusNextAction.current = false;
      button.focus();
    }
  }, []);
  const toggleTree = (event: MouseEvent<HTMLButtonElement>) => {
    const panel = fileTreePanel.current;
    if (!panel) return;
    if (treeOpen) panel.collapse();
    else panel.resize(expandedWidth.current);
    focusNextAction.current = treeOpen === panel.isCollapsed() && event.currentTarget === document.activeElement;
  };
  const label = treeOpen ? t("fileTree.collapse") : t("fileTree.expand");
  const TreeIcon = treeOpen ? PanelLeftClose : PanelLeftOpen;
  const action = (
    <Button
      ref={focusAction}
      variant="ghost"
      size="icon-xs"
      className="size-6.5 text-text-muted hover:bg-surface-2 hover:text-text-primary"
      onClick={toggleTree}
      title={label}
      aria-label={label}
      aria-controls={treeId}
      aria-expanded={treeOpen}
    >
      <TreeIcon className="size-3.5" aria-hidden />
    </Button>
  );

  return (
    <div className="min-h-0 min-w-0 flex-1">
      <ResizablePanelGroup orientation="horizontal" onLayoutChange={(layout) => setTreeOpen((layout[treeId] ?? 0) > 0)}>
        <ResizablePanel
          id={treeId}
          panelRef={fileTreePanel}
          defaultSize={initialWidth}
          minSize={FILE_TREE_MIN_WIDTH}
          maxSize={`${FILE_TREE_MAX_PERCENT}%`}
          collapsible
          collapsedSize={0}
          groupResizeBehavior="preserve-pixel-size"
          inert={!treeOpen}
          className={treeOpen ? undefined : "invisible"}
          onResize={({ asPercentage, inPixels }, _id, previousSize) => {
            // 收起、隐藏工作区及极窄布局的尺寸不应覆盖展开时的宽度。
            if (
              !Number.isFinite(inPixels) ||
              inPixels < FILE_TREE_MIN_WIDTH ||
              inPixels === expandedWidth.current ||
              inPixels === previousSize?.inPixels
            ) {
              return;
            }
            const layoutPercentage = fileTreePanel.current?.getSize().asPercentage;
            // 父容器调整期间，观察回调可能先读到旧布局；等实际比例与面板分配的比例一致再处理。
            if (layoutPercentage === undefined || Math.abs(layoutPercentage - asPercentage) > 0.5) return;
            // 外层变窄后碰到比例上限时，保留用户原先选定的宽度，供重新展开使用。
            if (layoutPercentage === FILE_TREE_MAX_PERCENT && inPixels < expandedWidth.current) return;
            expandedWidth.current = inPixels;
            try {
              localStorage.setItem(FILE_TREE_WIDTH_KEY, String(inPixels));
            } catch {
              // 存储受限时，本次打开的工作区仍记住宽度。
            }
          }}
        >
          <div className="artifacts-explorer flex h-full min-h-0 flex-col overflow-hidden bg-slate-50">
            {renderTree(treeOpen ? action : null)}
          </div>
        </ResizablePanel>
        <ResizableHandle
          disabled={!treeOpen}
          className={treeOpen ? "artifacts-workbench-divider bg-border-subtle" : "hidden"}
        />
        <ResizablePanel minSize={PREVIEW_MIN_WIDTH}>
          <div className="flex h-full min-h-0 min-w-0 flex-col">{renderPreview(treeOpen ? null : action)}</div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
