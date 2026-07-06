"use client";

import { ChevronDown, ChevronRight, Loader2, RotateCw } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { NS } from "../../src/i18n";
import { cn } from "../../src/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TreeNodeData {
  id: string;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  hasChildren?: boolean;
  badge?: string | number;
  description?: string;
  isDisabled?: boolean;
}

export type ChildrenLoader = (parentId: string | null) => Promise<TreeNodeData[]>;

export interface NodeState {
  expanded: boolean;
  selected: boolean;
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  visibleChildren: TreeNodeData[];
}

interface TreeNodeState {
  data: TreeNodeData;
  childrenIds: string[] | null;
  expanded: boolean;
  loading: boolean;
  error: string | null;
  visibleCount: number;
}

export interface TreeHandle {
  refetch: (nodeId?: string | null) => Promise<void>;
}

interface TreeContextValue {
  nodes: Map<string, TreeNodeState>;
  rootIds: string[];
  selectedId: string | null;
  expandedSet: Set<string>;
  maxVisibleItems: number;
  select: (nodeId: string | null) => void;
  toggle: (nodeId: string) => void;
  loadChildren: (nodeId: string | null) => Promise<void>;
  showMore: (nodeId: string) => void;
  getNodeState: (nodeId: string) => NodeState;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const TreeContext = createContext<TreeContextValue | null>(null);

function useTreeContext(): TreeContextValue {
  const ctx = useContext(TreeContext);
  if (!ctx) throw new Error("Tree compound components must be used inside <Tree>");
  return ctx;
}

// ---------------------------------------------------------------------------
// State Hook
// ---------------------------------------------------------------------------

function useTreeState(opts: {
  getChildren: ChildrenLoader;
  maxVisibleItems: number;
  defaultExpandedIds?: string[];
  controlledSelectedId?: string | null;
  defaultSelectedId?: string | null;
  onSelect?: (nodeId: string | null, node: TreeNodeData) => void;
  onToggle?: (nodeId: string, expanded: boolean) => void;
}) {
  const {
    getChildren,
    maxVisibleItems,
    defaultExpandedIds,
    controlledSelectedId,
    defaultSelectedId,
    onSelect,
    onToggle,
  } = opts;

  const [nodes, setNodes] = useState<Map<string, TreeNodeState>>(new Map());
  const [rootIds, setRootIds] = useState<string[]>([]);
  const [expandedSet, setExpandedSet] = useState<Set<string>>(() => new Set(defaultExpandedIds ?? []));
  const [internalSelectedId, setInternalSelectedId] = useState<string | null>(defaultSelectedId ?? null);
  const loadingRef = useRef<Set<string>>(new Set());

  const selectedId = controlledSelectedId !== undefined ? controlledSelectedId : internalSelectedId;

  const loadChildren = useCallback(
    async (parentId: string | null) => {
      const key = parentId ?? "__root__";
      if (loadingRef.current.has(key)) return;
      loadingRef.current.add(key);

      setNodes((prev) => {
        const next = new Map(prev);
        if (parentId) {
          const node = next.get(parentId);
          if (node) next.set(parentId, { ...node, loading: true, error: null });
        }
        return next;
      });

      try {
        const items = await getChildren(parentId);

        setNodes((prev) => {
          const next = new Map(prev);
          for (const item of items) {
            const existing = next.get(item.id);
            next.set(item.id, {
              data: item,
              childrenIds: existing?.childrenIds ?? (item.hasChildren === false ? [] : null),
              expanded: existing?.expanded ?? false,
              loading: false,
              error: null,
              visibleCount: maxVisibleItems,
            });
          }
          if (parentId) {
            const parent = next.get(parentId);
            if (parent) {
              next.set(parentId, {
                ...parent,
                childrenIds: items.map((i) => i.id),
                loading: false,
                error: null,
              });
            }
          }
          return next;
        });

        if (parentId === null) {
          setRootIds(items.map((i) => i.id));
        }
      } catch (err) {
        setNodes((prev) => {
          const next = new Map(prev);
          if (parentId) {
            const node = next.get(parentId);
            if (node) next.set(parentId, { ...node, loading: false, error: String(err) });
          }
          return next;
        });
        console.error("[Tree] Failed to load children:", err);
      } finally {
        loadingRef.current.delete(key);
      }
    },
    [getChildren, maxVisibleItems],
  );

  const toggle = useCallback(
    (nodeId: string) => {
      setExpandedSet((prev) => {
        const next = new Set(prev);
        const isExpanded = next.has(nodeId);
        if (isExpanded) {
          next.delete(nodeId);
        } else {
          next.add(nodeId);
        }
        onToggle?.(nodeId, !isExpanded);
        return next;
      });

      const node = nodes.get(nodeId);
      if (node && node.childrenIds === null) {
        loadChildren(nodeId);
      }
    },
    [nodes, loadChildren, onToggle],
  );

  const select = useCallback(
    (nodeId: string | null) => {
      if (controlledSelectedId === undefined) {
        setInternalSelectedId(nodeId);
      }
      if (nodeId) {
        const node = nodes.get(nodeId);
        if (node) onSelect?.(nodeId, node.data);
      } else {
        onSelect?.(null, undefined as never);
      }
    },
    [controlledSelectedId, nodes, onSelect],
  );

  const showMore = useCallback(
    (nodeId: string) => {
      setNodes((prev) => {
        const next = new Map(prev);
        const node = next.get(nodeId);
        if (node) {
          next.set(nodeId, { ...node, visibleCount: node.visibleCount + maxVisibleItems });
        }
        return next;
      });
    },
    [maxVisibleItems],
  );

  const getNodeState = useCallback(
    (nodeId: string): NodeState => {
      const node = nodes.get(nodeId);
      if (!node) {
        return {
          expanded: false,
          selected: false,
          loading: false,
          error: null,
          hasMore: false,
          visibleChildren: [],
        };
      }
      const children =
        node.childrenIds?.map((id) => nodes.get(id)?.data).filter((d): d is TreeNodeData => d !== undefined) ?? [];
      const truncated = children.length - Math.min(node.visibleCount, children.length);
      return {
        expanded: expandedSet.has(nodeId),
        selected: selectedId === nodeId,
        loading: node.loading,
        error: node.error,
        hasMore: truncated > 0,
        visibleChildren: children.slice(0, node.visibleCount),
      };
    },
    [nodes, expandedSet, selectedId],
  );

  // 根节点加载后，自动重载已展开节点的子节点（处理 key 变化导致的重新挂载）
  const expandedReloadedRef = useRef(false);
  useEffect(() => {
    if (rootIds.length === 0 || expandedSet.size === 0) return;
    if (expandedReloadedRef.current) return;
    expandedReloadedRef.current = true;
    for (const nodeId of expandedSet) {
      loadChildren(nodeId);
    }
  }, [rootIds, expandedSet, loadChildren]);

  return {
    nodes,
    rootIds,
    selectedId,
    expandedSet,
    maxVisibleItems,
    select,
    toggle,
    loadChildren,
    showMore,
    getNodeState,
  };
}

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: getChildren 变化时需要重新加载根节点
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
          <span className="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-0.5">
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

// ---------------------------------------------------------------------------
// TreeLabelTip — 鼠标悬停 0.4s 后弹出全名浮窗，位置固定，离开消失
// ---------------------------------------------------------------------------

function TreeLabelTip({ label, children }: { label: string; children: ReactNode }) {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!visible) {
        // 浮窗未出现：记录最新鼠标位置，延时 0.4s 弹出
        clearTimeout(timerRef.current);
        const { clientX, clientY } = e;
        timerRef.current = setTimeout(() => {
          setPos({ x: clientX, y: clientY });
          setVisible(true);
        }, 400);
      }
      // 浮窗已出现：位置固定，不再更新
    },
    [visible],
  );

  const handleMouseLeave = useCallback(() => {
    clearTimeout(timerRef.current);
    setVisible(false);
  }, []);

  return (
    <span className="flex-1 min-w-0" onMouseMove={handleMouseMove} onMouseLeave={handleMouseLeave}>
      {children}
      {visible && (
        <span
          className="fixed z-50 max-w-xs rounded-md border border-border bg-surface-1 px-2.5 py-1 text-xs text-text-primary shadow-md pointer-events-none break-all"
          style={{ left: pos.x + 12, top: pos.y + 18 }}
        >
          {label}
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// ShowMoreButton (internal)
// ---------------------------------------------------------------------------

interface ShowMoreButtonProps {
  remaining: number;
  onClick: () => void;
  depth: number;
}

function ShowMoreButton({ remaining, onClick, depth }: ShowMoreButtonProps) {
  const { t } = useTranslation(NS.COMPONENTS);
  return (
    <button
      type="button"
      className="flex items-center gap-1 h-8 pr-2 text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 rounded-sm cursor-pointer w-full"
      style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}
      onClick={onClick}
    >
      {t("tree.showMore", { count: remaining })}
    </button>
  );
}
