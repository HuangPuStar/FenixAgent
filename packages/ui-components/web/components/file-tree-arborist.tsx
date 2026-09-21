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
import { FileTypeIcon } from "./file-icon-helper";
import type { ParsedFileNode } from "./file-tree-model";
import "./file-tree.css";

/** 行高与缩进；行高同时用于 sticky 目录条的可见行索引换算。 */
const ROW_HEIGHT = 32;
const INDENT = 12;

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
    <div ref={containerRef} className="file-tree-arborist">
      {stickyFolder && (
        <div className="file-tree-arborist-sticky-folder" aria-hidden>
          <FolderOpen />
          <span>{stickyFolder.path}</span>
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
      className={`file-tree-arborist-row group${node.isSelected ? " is-selected" : ""}`}
      data-tree-item
      data-node-id={data.path}
      data-is-dir={data.isDir ? "true" : "false"}
      onClick={handleSelect}
    >
      <button
        type="button"
        className="file-tree-arborist-toggle"
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
          <span className="file-tree-arborist-icon file-real-file-icon">
            <FileTypeIcon filename={data.name} />
          </span>
        )}
      </button>
      <span className="file-tree-arborist-name" title={data.name}>
        {data.name}
      </span>
      <span data-slot="tree-item-actions" className="file-tree-arborist-actions">
        {data.isDir && (
          <button
            type="button"
            className="file-tree-row-action"
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
          className="file-tree-row-action"
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
          className="file-tree-row-action file-tree-row-action--delete"
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
