import { ChevronDown, ChevronRight, Loader2, RotateCw } from "lucide-react";
import type * as React from "react";
import { type ReactNode, useEffect, useMemo } from "react";
import { cn } from "../lib/cn";
import { TreeContext, useTreeContext } from "./internal/tree-context";
import { ShowMoreButton, TreeLabelTip } from "./internal/tree-item-parts";
import { useTreeState } from "./internal/tree-state";
import type { ChildrenLoader, NodeState, TreeContextValue, TreeHandle, TreeNodeData } from "./internal/tree-types";

/**
 * 树形控件（复合组件）：Tree 负责状态与上下文，TreeItem 负责单节点渲染并递归子节点。
 *
 * 状态逻辑、类型与渲染碎片分别位于 ./internal/tree-state、./internal/tree-types、
 * ./internal/tree-item-parts（源文件超过 500 行红线后的按职责拆分）。公开导出与拆分前完全一致。
 *
 * 文案通过 react-i18next 的包内命名空间读取，宿主必须在 render 前注册
 * `web/i18n/locales/<lng>/uiComponents.json`，详见 ../lib/i18n。
 */

// 公开类型定义在 ./internal/tree-types（供 internal/ 内多个文件共享，避免类型环），此处原样再导出。
export type { ChildrenLoader, NodeState, TreeHandle, TreeNodeData };

// ---------------------------------------------------------------------------
// Tree (Root)
// ---------------------------------------------------------------------------

export interface TreeProps {
  getChildren: ChildrenLoader;
  maxVisibleItems?: number;
  defaultExpandedIds?: string[];
  selectedId?: string | null;
  defaultSelectedId?: string | null;
  onSelect?: (nodeId: string | null, node: TreeNodeData) => void;
  onToggle?: (nodeId: string, expanded: boolean) => void;
  renderActions?: (node: TreeNodeData, state: NodeState) => ReactNode;
  renderLabel?: (node: TreeNodeData, state: NodeState) => ReactNode;
  className?: string;
  children?: ReactNode;
}

export function Tree({
  getChildren,
  maxVisibleItems = 100,
  defaultExpandedIds,
  selectedId: controlledSelectedId,
  defaultSelectedId,
  onSelect,
  onToggle,
  renderActions,
  renderLabel,
  className,
  children,
}: TreeProps) {
  const state = useTreeState({
    getChildren,
    maxVisibleItems,
    defaultExpandedIds,
    controlledSelectedId,
    defaultSelectedId,
    onSelect,
    onToggle,
  });

  // getChildren 变化时需要重新加载根节点。
  // biome-ignore lint/correctness/useExhaustiveDependencies: getChildren 的 prop 引用变化必须触发根节点重载，移除该依赖会改变行为。
  useEffect(() => {
    state.loadChildren(null);
  }, [state.loadChildren, getChildren]);

  const ctx = useMemo<TreeContextValue>(
    () => ({
      nodes: state.nodes,
      rootIds: state.rootIds,
      selectedId: state.selectedId,
      expandedSet: state.expandedSet,
      maxVisibleItems: state.maxVisibleItems,
      select: state.select,
      toggle: state.toggle,
      loadChildren: state.loadChildren,
      showMore: state.showMore,
      getNodeState: state.getNodeState,
    }),
    [
      state.nodes,
      state.rootIds,
      state.selectedId,
      state.expandedSet,
      state.maxVisibleItems,
      state.select,
      state.toggle,
      state.loadChildren,
      state.showMore,
      state.getNodeState,
    ],
  );

  const childContent =
    children ??
    state.rootIds.map((id) => (
      <TreeItem key={id} nodeId={id} renderActions={renderActions} renderLabel={renderLabel} />
    ));

  return (
    <TreeContext.Provider value={ctx}>
      <div role="tree" data-slot="tree" className={cn("text-base select-none", className)}>
        {childContent}
      </div>
    </TreeContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// TreeItem
// ---------------------------------------------------------------------------

export interface TreeItemProps {
  nodeId: string;
  nodeData?: TreeNodeData;
  renderActions?: (node: TreeNodeData, state: NodeState) => ReactNode;
  renderLabel?: (node: TreeNodeData, state: NodeState) => ReactNode;
  className?: string;
  children?: ReactNode;
  depth?: number;
}

export function TreeItem({
  nodeId,
  nodeData: nodeDataProp,
  renderActions,
  renderLabel,
  className,
  children,
  depth = 0,
}: TreeItemProps) {
  const ctx = useTreeContext();
  const nodeState = ctx.nodes.get(nodeId);
  const data = nodeDataProp ?? nodeState?.data;

  if (!data) return null;

  const state = ctx.getNodeState(nodeId);
  const hasChildrenIndicator =
    data.hasChildren !== false &&
    (nodeState?.childrenIds === null || (nodeState?.childrenIds?.length ?? 0) > 0 || data.hasChildren === true);
  const showChevron = hasChildrenIndicator;

  const handleRowClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    ctx.select(nodeId);
    if (hasChildrenIndicator) {
      ctx.toggle(nodeId);
    }
  };

  const handleChevronClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    ctx.toggle(nodeId);
  };

  const handleRetry = (e: React.MouseEvent) => {
    e.stopPropagation();
    ctx.loadChildren(nodeId);
  };

  const handleShowMore = () => {
    ctx.showMore(nodeId);
  };

  const childContent =
    children ??
    state.visibleChildren.map((child) => (
      <TreeItem
        key={child.id}
        nodeId={child.id}
        renderActions={renderActions}
        renderLabel={renderLabel}
        depth={depth + 1}
      />
    ));

  const truncated = (nodeState?.childrenIds?.length ?? 0) - state.visibleChildren.length;

  return (
    <div role="treeitem" aria-expanded={state.expanded} tabIndex={0} data-slot="tree-item" data-node-id={nodeId}>
      {/* Node row */}
      <div
        className={cn(
          "group relative flex items-center gap-0.5 h-8 pr-2 rounded-sm cursor-pointer",
          "hover:bg-accent/50",
          state.selected && "bg-primary/10 text-primary border-l-2 border-primary -ml-[2px]",
          data.isDisabled && "opacity-50 pointer-events-none",
          className,
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={handleRowClick}
      >
        {/* Chevron */}
        <span
          className={cn("flex items-center justify-center", showChevron ? "flex-shrink-0 w-6 h-6" : "w-0")}
          onClick={showChevron ? handleChevronClick : undefined}
        >
          {state.loading ? (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          ) : state.error ? (
            <button type="button" onClick={handleRetry} className="text-destructive hover:text-destructive/80">
              <RotateCw className="h-5 w-5" />
            </button>
          ) : showChevron ? (
            state.expanded ? (
              <ChevronDown className="h-5 w-5 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-5 w-5 text-muted-foreground" />
            )
          ) : null}
        </span>

        {/* Icon — renderLabel 自带图标时跳过，避免重复间距 */}
        {!renderLabel &&
          (data.icon ? (
            <data.icon className="h-5 w-5 flex-shrink-0 text-muted-foreground" />
          ) : (
            <span className="w-5 flex-shrink-0" />
          ))}

        {/* Label area — 鼠标悬停时跟随光标显示全名浮窗 */}
        <TreeLabelTip label={data.label}>
          <span className="flex-1 min-w-0 truncate">{renderLabel ? renderLabel(data, state) : data.label}</span>
        </TreeLabelTip>

        {/* Description */}
        {data.description && !renderLabel && (
          <span className="text-xs text-muted-foreground truncate hidden sm:inline">{data.description}</span>
        )}

        {/* Badge */}
        {data.badge !== undefined && !renderLabel && (
          <span className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
            {data.badge}
          </span>
        )}

        {/* Actions */}
        {renderActions && (
          <span
            data-slot="tree-item-actions"
            className="flex-shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity flex items-center gap-0.5"
          >
            {renderActions(data, state)}
          </span>
        )}
      </div>

      {/* Children (collapsible) */}
      {state.expanded && (
        <div role="group" className="relative">
          {childContent}
          {state.hasMore && <ShowMoreButton remaining={truncated} onClick={handleShowMore} depth={depth} />}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TreeItemContent (optional override)
// ---------------------------------------------------------------------------

export interface TreeItemContentProps {
  children?: ReactNode;
  className?: string;
}

export function TreeItemContent({ children, className }: TreeItemContentProps) {
  return (
    <span data-slot="tree-item-content" className={cn("flex-1 min-w-0", className)}>
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// TreeItemGroup (optional override)
// ---------------------------------------------------------------------------

export interface TreeItemGroupProps {
  children?: ReactNode;
  className?: string;
}

export function TreeItemGroup({ children, className }: TreeItemGroupProps) {
  return (
    <div data-slot="tree-item-group" role="group" className={cn("relative overflow-hidden", className)}>
      {children}
    </div>
  );
}
