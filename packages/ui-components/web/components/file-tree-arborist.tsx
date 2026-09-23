/**
 * react-arborist 文件树（从 apps/web 的 `agent-panel/file-tree-view.tsx` 拆出）。
 *
 * 纯化取舍：
 * 1. 源实现的 `ArboristFileTree` 直接接收整个 `FileTreeViewProps` 并用 `propsRef` 转发给节点渲染器；
 *    本包改为聚焦的 props 接口，只保留树自身需要的回调。
 * 2. `treeVersion` / `normalizedSearch` 不属于本组件：源实现把它们编进父级的 React `key`
 *    来强制 Arborist 重新挂载，重建逻辑留在 `FileTreeView`。
 * 3. i18n 从宿主的 `NS.COMPONENTS` 改为包内 `UI_COMPONENTS_NS`。
 * 4. 行高 32 在源实现里同时出现在 `rowHeight` 与 sticky 目录条的行索引换算中，
 *    抽成 `ROW_HEIGHT` 常量避免两处漂移（行为不变）。
 */

import { FilePlus2, Folder, FolderOpen, RefreshCw, Trash2 } from "lucide-react";
import type { MouseEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NodeRendererProps, TreeApi } from "react-arborist";
import { Tree as ArboristTree } from "react-arborist";
import { useTranslation } from "react-i18next";

import { UI_COMPONENTS_NS } from "../i18n/namespace";
import { cn } from "../lib/cn";
import { FileTypeIcon } from "./file-icon-helper";
import "./file-tree-arborist.css";
import type { ParsedFileNode } from "./file-tree-model";

/** 行高与缩进；行高同时用于 sticky 目录条的可见行索引换算。 */
const ROW_HEIGHT = 32;
const INDENT = 12;

/**
 * 行内操作按钮（新建 / 刷新）的样式；由原先的 `.file-tree-row-action` 及其 `:hover` / `:focus-visible`
 * / `svg` 规则逐条翻译而来，26px 方块 + 14px 图标。图标尺寸下沉到 `file-tree-arborist.css`，
 * 其余扁平工具类留在下面常量里。
 */
const ROW_ACTION_CLASS =
  "file-tree-row-action inline-grid size-6.5 place-items-center rounded-sm text-text-muted hover:bg-surface-2 hover:text-text-primary focus-visible:bg-surface-2 focus-visible:text-text-primary";

/**
 * 删除按钮样式。原 `.file-tree-row-action--delete` 在靠后的规则里整体覆盖了悬停配色（底色改危险色浅底、
 * 文字改危险色），这里直接写成独立一份，避免与通用悬停类在同属性上争夺优先级。
 * 图标尺寸与通用态同值，合并写在 `file-tree-arborist.css` 里。
 */
const ROW_ACTION_DANGER_CLASS =
  "file-tree-row-action--delete inline-grid size-6.5 place-items-center rounded-sm text-text-muted hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive";

export interface FileTreeArboristProps {
  data: ParsedFileNode[];
  /** 展开节点 id 列表，由调用方持久化，用于跨刷新恢复展开状态。 */
  expandedIds: string[];
  onSelect: (node: ParsedFileNode) => void;
  onToggle: (nodeId: string, expanded: boolean) => void;
  onRefresh: () => void;
  onNewFile: (parentPath: string) => void;
  onDeleteRequest: (path: string, name: string) => void;
}

/**
 * 虚拟滚动的文件树；高度取自容器实测值（Arborist 需要确定高度才能虚拟化）。
 * 顶部用覆盖层显示当前滚动位置的所属目录，不占布局空间。
 */
export function FileTreeArborist({
  data,
  expandedIds,
  onSelect,
  onToggle,
  onRefresh,
  onNewFile,
  onDeleteRequest,
}: FileTreeArboristProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const containerRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<TreeApi<ParsedFileNode> | undefined>(undefined);
  const [height, setHeight] = useState(0);
  const [stickyFolder, setStickyFolder] = useState<ParsedFileNode | null>(null);
  // 节点渲染器由 Arborist 缓存，通过 ref 读取最新回调，避免每次父级重渲染都重建整棵树。
  const propsRef = useRef({ onSelect, onToggle, onRefresh, onNewFile, onDeleteRequest });
  propsRef.current = { onSelect, onToggle, onRefresh, onNewFile, onDeleteRequest };
  const initialOpenState = useMemo(() => Object.fromEntries(expandedIds.map((id) => [id, true])), [expandedIds]);

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
          <FolderOpen />
          <span className="ml-auto">{stickyFolder.path}</span>
        </div>
      )}
      {height > 0 && (
        <ArboristTree
          data={data}
          ref={treeRef}
          idAccessor="path"
          childrenAccessor="children"
          initialOpenState={initialOpenState}
          openByDefault={false}
          disableDrag
          disableDrop
          disableEdit
          disableMultiSelection
          rowHeight={ROW_HEIGHT}
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
  );
}

/** 单行节点：目录可折叠、文件显示类型图标，行内操作按钮仅在悬停/聚焦时可见。 */
function FileTreeNode({
  node,
  style,
  dragHandle,
  viewProps,
}: NodeRendererProps<ParsedFileNode> & { viewProps: Omit<FileTreeArboristProps, "data" | "expandedIds"> }) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const data = node.data;
  const handleSelect = () => {
    node.select();
    viewProps.onSelect(data);
    if (data.isDir) {
      const expanded = !node.isOpen;
      node.toggle();
      viewProps.onToggle(data.path, expanded);
    }
  };
  const handleToggle = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const expanded = !node.isOpen;
    node.toggle();
    viewProps.onToggle(data.path, expanded);
  };

  return (
    <div
      ref={dragHandle}
      style={{ ...style, paddingLeft: node.level * INDENT + 8 }}
      className={cn(
        "group/row relative box-border flex max-w-full min-w-0 cursor-pointer items-center gap-0.5 overflow-hidden rounded-xs pe-1.5",
        // 原 `.is-selected` 与 `:hover` 两条规则里，选中态在靠后位置整体覆盖悬停底色与文字色，
        // 这里按互斥两态写出，避免两条同属性工具类靠生成顺序决定胜负。
        node.isSelected ? "bg-brand/10 text-brand" : "text-text-secondary hover:bg-surface-2/70",
      )}
      data-tree-item
      data-node-id={data.path}
      data-is-dir={data.isDir ? "true" : "false"}
      onClick={handleSelect}
    >
      <button
        type="button"
        className="file-tree-arborist-toggle inline-grid size-6 shrink-0 place-items-center"
        aria-label={data.name}
        onClick={data.isDir ? handleToggle : undefined}
      >
        {data.isDir ? (
          node.isOpen ? (
            <FolderOpen aria-hidden />
          ) : (
            <Folder aria-hidden />
          )
        ) : (
          // 文件图标与目录图标共用同一个 16px 图标位：不再套 12px 的 `size-3` 内层容器
          // （那层容器让图标走行盒基线定位 —— 实测比行中心低 4.75px、比目录图标小 6.25px 且右移 3.13px）。
          // 图标位尺寸由 `file-tree-arborist.css` 的 `.file-tree-arborist-toggle > .file-type-icon` 决定，
          // 与目录图标同一条规则；这里不再写尺寸，避免被那条未分层规则静默压过。
          <FileTypeIcon filename={data.name} />
        )}
      </button>
      <span
        className="block w-0 min-w-0 flex-auto overflow-hidden text-ellipsis whitespace-nowrap text-sm"
        title={data.name}
      >
        {data.name}
      </span>
      <span
        data-slot="tree-item-actions"
        className="absolute top-1/2 right-1 z-[1] flex shrink-0 -translate-y-1/2 items-center gap-px bg-[linear-gradient(90deg,transparent,var(--color-surface-2)_18px)] pl-4.5 opacity-0 transition-opacity duration-[120ms] ease-[ease] group-hover/row:opacity-100 group-focus-within/row:opacity-100"
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
            <FilePlus2 aria-hidden />
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
          <RefreshCw aria-hidden />
        </button>
        <button
          type="button"
          className={ROW_ACTION_DANGER_CLASS}
          title={t("fileTree.contextMenu.delete")}
          onClick={(event) => {
            event.stopPropagation();
            viewProps.onDeleteRequest(data.path, data.name);
          }}
        >
          <Trash2 aria-hidden />
        </button>
      </span>
    </div>
  );
}
