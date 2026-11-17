/**
 * react-arborist 文件树（从 apps/web 的 `agent-panel/file-tree-view.tsx` 拆出）。
 *
 * 纯化取舍：
 * 1. 源实现的 `ArboristFileTree` 直接接收整个 `FileTreeViewProps` 并用 `propsRef` 转发给节点渲染器；
 *    本包改为聚焦的 props 接口，只保留树自身需要的回调。
 * 2. `treeVersion` / `normalizedSearch` 不属于本组件：源实现把它们编进父级的 React `key`
 *    来强制 Arborist 重新挂载，重建逻辑留在 `FileTreeView`。
 * 3. i18n 从宿主的 `NS.COMPONENTS` 改为包内 `UI_COMPONENTS_NS`。
 * 4. 行高同时用于虚拟列表与 sticky 目录的索引换算，两处共用 `ROW_HEIGHT`。
 */

import { FilePlus2, Folder, FolderOpen, RefreshCw } from "lucide-react";
import type { DragEvent, MouseEvent } from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { NodeRendererProps, RowRendererProps, TreeApi } from "react-arborist";
import { Tree as ArboristTree } from "react-arborist";
import { useTranslation } from "react-i18next";

import { UI_COMPONENTS_NS } from "../i18n/namespace";
import { cn } from "../lib/cn";
import { FileTypeIcon } from "./file-icon-helper";
import "./file-tree-arborist.css";
import type { FileTreeSelectionGesture, ParsedFileNode } from "./file-tree-model";
import { FileTreeLabel, FileTreeTooltip } from "./internal/file-tree-label";

/** 行高与缩进；行高同时用于 sticky 目录条的可见行索引换算。 */
const ROW_HEIGHT = 48;
const INDENT = 12;
const FileTreeClock = createContext(0);

/**
 * 行内操作按钮（新建 / 刷新）的样式；由原先的 `.file-tree-row-action` 及其 `:hover` / `:focus-visible`
 * / `svg` 规则逐条翻译而来，26px 方块 + 14px 图标。图标尺寸（`size-3.5`）写在各图标元素自身；
 * 原由 `.file-tree-row-action svg` / `.file-tree-row-action--delete svg` 声明的 14px 已于 2026-09-28
 * 撤回（两条选择器的取值相同，撤回后合并的那条规则删除）。其余扁平工具类留在下面常量里。
 */
const ROW_ACTION_CLASS =
  "file-tree-row-action inline-grid size-6.5 place-items-center rounded-sm text-text-muted hover:bg-surface-2 hover:text-text-primary focus-visible:bg-surface-2 focus-visible:text-text-primary";

/** 双分区共享的受控选择与原生拖动事件。 */
export interface FileTreeInteractionProps {
  selectedPaths: string[];
  onSelect: (node: ParsedFileNode, gesture: FileTreeSelectionGesture) => void;
  onSelectionChange: (paths: string[]) => void;
  onDragStart: (event: DragEvent<HTMLDivElement>, path: string) => void;
  onDragEnd: () => void;
  canMutate?: boolean;
  dropTarget?: string | null;
}

/** 虚拟树的展示、展开与操作入口。 */
export interface FileTreeArboristProps extends FileTreeInteractionProps {
  data: ParsedFileNode[];
  /** 展开节点 id 列表，由调用方持久化，用于跨刷新恢复展开状态。 */
  expandedIds: string[];
  onToggle: (nodeId: string, expanded: boolean) => void;
  onRefresh: () => void;
  onNewFile: (parentPath: string) => void;
}

/**
 * 虚拟滚动的文件树；高度取自容器实测值（Arborist 需要确定高度才能虚拟化）。
 * 顶部用覆盖层显示当前滚动位置的所属目录，不占布局空间。
 */
export function FileTreeArborist({
  data,
  expandedIds,
  onSelect,
  selectedPaths,
  onSelectionChange,
  onDragStart,
  onDragEnd,
  canMutate,
  dropTarget,
  onToggle,
  onRefresh,
  onNewFile,
}: FileTreeArboristProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const containerRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<TreeApi<ParsedFileNode> | undefined>(undefined);
  const [height, setHeight] = useState(0);
  const [now, setNow] = useState(Date.now);
  const [stickyFolder, setStickyFolder] = useState<ParsedFileNode | null>(null);
  // 节点渲染器由 Arborist 缓存，通过 ref 读取最新回调，避免每次父级重渲染都重建整棵树。
  const propsRef = useRef({
    onSelect,
    selectedPaths,
    onSelectionChange,
    onDragStart,
    onDragEnd,
    canMutate,
    dropTarget,
    onToggle,
    onRefresh,
    onNewFile,
  });
  propsRef.current = {
    onSelect,
    selectedPaths,
    onSelectionChange,
    onDragStart,
    onDragEnd,
    canMutate,
    dropTarget,
    onToggle,
    onRefresh,
    onNewFile,
  };
  const syncingSelectionRef = useRef(false);
  const selectionReadyRef = useRef(false);
  const initialOpenState = useMemo(() => Object.fromEntries(expandedIds.map((id) => [id, true])), [expandedIds]);

  useEffect(() => {
    // 虚拟树共享时钟，只更新可见行，避免每个文件各自维护定时器。
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const updateStickyFolder = useCallback((scrollOffset = 0) => {
    // scrollOffset 为 0 表示列表处于顶部，此时不应显示 sticky，也不能为 sticky 预留空白行。
    if (scrollOffset <= 0) {
      setStickyFolder(null);
      return;
    }
    const visibleNodes = treeRef.current?.visibleNodes ?? [];
    // Arborist 的 scrollOffset 与虚拟列表行索引直接对应，不再人为扣除 sticky 高度；sticky 是覆盖层，不占布局空间。
    const firstVisibleIndex = Math.max(0, Math.floor(scrollOffset / ROW_HEIGHT));
    const firstVisibleNode = visibleNodes.find((node) => (node.rowIndex ?? -1) >= firstVisibleIndex);
    let folder = firstVisibleNode?.data.isDir ? firstVisibleNode : firstVisibleNode?.parent;
    while (folder && !folder.data.isDir) folder = folder.parent;
    setStickyFolder(folder?.data ?? null);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const updateHeight = () => setHeight(container.clientHeight);
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (height > 0) updateStickyFolder();
  }, [height, updateStickyFolder]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 测高后树才挂载，展开变化也须同步第三方 aria 选择。
  useEffect(() => {
    const tree = treeRef.current;
    if (!tree) return;
    const ids = selectedPaths.filter((path) => tree.get(path));
    // 两棵树共同消费外层选择；回写第三方的 aria 状态时不能再次触发外层更新。
    syncingSelectionRef.current = true;
    try {
      tree.setSelection({ ids, anchor: ids[0] ?? null, mostRecent: ids.at(-1) ?? null });
    } finally {
      syncingSelectionRef.current = false;
      selectionReadyRef.current = true;
    }
  }, [height, selectedPaths, expandedIds]);

  const handleScroll = useCallback(
    ({ scrollOffset }: { scrollOffset: number }) => {
      requestAnimationFrame(() => updateStickyFolder(scrollOffset));
    },
    [updateStickyFolder],
  );

  const Node = useCallback(
    (rendererProps: NodeRendererProps<ParsedFileNode>) => (
      <FileTreeNode {...rendererProps} viewProps={propsRef.current} />
    ),
    [],
  );

  return (
    <FileTreeClock.Provider value={now}>
      <div
        ref={containerRef}
        data-slot="file-tree-arborist"
        className="relative size-full min-h-0 min-w-0 overflow-hidden"
      >
        {stickyFolder && (
          <div
            className="file-tree-arborist-sticky-folder pointer-events-none absolute inset-x-0 top-0 z-[2] flex h-8 items-center gap-0.5 border-b border-border-subtle bg-surface-2 px-2.5 text-sm font-normal text-text-secondary"
            aria-hidden
          >
            <FolderOpen className="size-4" />
            <span className="ml-auto">{stickyFolder.path}</span>
          </div>
        )}
        {height > 0 && (
          <ArboristTree
            data={data}
            ref={treeRef}
            idAccessor="path"
            childrenAccessor={(node) => (node.isDir ? node.children : null)}
            initialOpenState={initialOpenState}
            openByDefault={false}
            disableDrag
            disableDrop
            disableEdit
            onSelect={(nodes) => {
              if (selectionReadyRef.current && !syncingSelectionRef.current)
                onSelectionChange(nodes.map((node) => node.id));
            }}
            onActivate={(node) => onSelect(node.data, { toggle: false, range: false })}
            onToggle={(id) => onToggle(id, treeRef.current?.get(id)?.isOpen ?? false)}
            rowHeight={ROW_HEIGHT}
            renderRow={FileTreeRow}
            indent={INDENT}
            overscanCount={8}
            width="100%"
            height={height}
            onScroll={handleScroll}
            aria-label={t("fileTree.accessibleName")}
          >
            {Node}
          </ArboristTree>
        )}
      </div>
    </FileTreeClock.Provider>
  );
}

/** 保留 Arborist 默认行的焦点与选择行为，让提示绑定真实的 treeitem 焦点。 */
function FileTreeRow({ node, attrs, innerRef, children }: RowRendererProps<ParsedFileNode>) {
  return (
    <FileTreeTooltip node={node.data}>
      <div {...attrs} ref={innerRef} onFocus={(event) => event.stopPropagation()} onClick={node.handleClick}>
        {children}
      </div>
    </FileTreeTooltip>
  );
}

/** 目录可折叠，文件显示双行标签，行内操作仅在悬停或聚焦时可见。 */
function FileTreeNode({
  node,
  style,
  viewProps,
}: NodeRendererProps<ParsedFileNode> & { viewProps: Omit<FileTreeArboristProps, "data" | "expandedIds"> }) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const data = node.data;
  const now = useContext(FileTreeClock);
  const handleSelect = (event: MouseEvent<HTMLElement>) => {
    event.stopPropagation();
    node.tree.focus(node.id, { scroll: false });
    const gesture = { toggle: event.metaKey || event.ctrlKey, range: event.shiftKey };
    viewProps.onSelect(data, gesture);
    if (data.isDir && !gesture.toggle && !gesture.range) node.toggle();
  };
  const handleToggle = (event: MouseEvent<HTMLButtonElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey) {
      handleSelect(event);
      return;
    }
    event.stopPropagation();
    node.toggle();
  };

  return (
    <div
      style={{ ...style, paddingLeft: node.level * INDENT + 8 }}
      className={cn(
        "group/row relative box-border flex max-w-full min-w-0 cursor-pointer items-center gap-0.5 overflow-hidden rounded-xs pe-1.5 h-full",
        // 原 `.is-selected` 与 `:hover` 两条规则里，选中态在靠后位置整体覆盖悬停底色与文字色，
        // 这里按互斥两态写出，避免两条同属性工具类靠生成顺序决定胜负。
        viewProps.selectedPaths.includes(data.path)
          ? "bg-brand/10 text-brand"
          : "text-text-secondary hover:bg-surface-2/70",
        viewProps.dropTarget === data.path && "ring-1 ring-inset ring-brand bg-brand/10",
      )}
      data-tree-item
      data-node-id={data.path}
      data-is-dir={data.isDir ? "true" : "false"}
      onClick={handleSelect}
      draggable={viewProps.canMutate ?? true}
      onDragStart={(event) => {
        event.stopPropagation();
        viewProps.onDragStart(event, data.path);
      }}
      onDragEnd={viewProps.onDragEnd}
    >
      <button
        type="button"
        className="file-tree-arborist-toggle inline-grid size-6 shrink-0 place-items-center"
        aria-label={data.name}
        onClick={data.isDir ? handleToggle : undefined}
      >
        {data.isDir ? (
          node.isOpen ? (
            <FolderOpen className="size-4" aria-hidden />
          ) : (
            <Folder className="size-4" aria-hidden />
          )
        ) : (
          // 文件图标与目录图标共用同一个 16px 图标位：不再套 12px 的 `size-3` 内层容器
          // （那层容器让图标走行盒基线定位 —— 实测比行中心低 4.75px、比目录图标小 6.25px 且右移 3.13px）。
          // 目录图标的 16px 写在图标元素自身（`size-4`，原 `.file-tree-arborist-toggle > svg` 的未分层
          // 声明已于 2026-09-28 撤回）；文件图标同样 16px，由 `FileTypeIcon` 的外框默认类 `size-4` 提供，
          // 与目录图标等值。这里不再写尺寸——外框自带默认档，重复传一次只会多一份同值类。
          <FileTypeIcon filename={data.name} />
        )}
      </button>
      <FileTreeLabel node={data} now={now} />
      <span
        data-slot="tree-item-actions"
        className={cn(
          "absolute right-1 z-[1] flex shrink-0 items-center gap-px bg-[linear-gradient(90deg,transparent,var(--color-surface-2)_18px)] pl-4.5 opacity-0 transition-opacity duration-[120ms] ease-[ease] group-hover/row:opacity-100 group-focus-within/row:opacity-100",
          data.isDir ? "top-1/2 -translate-y-1/2" : "top-0.5",
        )}
      >
        {data.isDir && (
          <button
            type="button"
            className={ROW_ACTION_CLASS}
            title={t("fileTree.newFile")}
            onClick={(event) => {
              event.stopPropagation();
              viewProps.onNewFile(data.path);
            }}
          >
            <FilePlus2 className="size-3.5" aria-hidden />
          </button>
        )}
        <button
          type="button"
          className={ROW_ACTION_CLASS}
          title={t("fileTree.refresh")}
          onClick={(event) => {
            event.stopPropagation();
            viewProps.onRefresh();
          }}
        >
          <RefreshCw className="size-3.5" aria-hidden />
        </button>
      </span>
    </div>
  );
}
