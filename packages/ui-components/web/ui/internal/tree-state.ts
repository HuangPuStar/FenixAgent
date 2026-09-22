import { useCallback, useEffect, useRef, useState } from "react";
import type { ChildrenLoader, NodeState, TreeNodeData, TreeNodeState } from "./tree-types";

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

/**
 * 按 `parentId` 原位替换父节点的 `loading` / `error`（不改动 Map 里的其他节点）。
 *
 * 2026-09-22 库内去重：`loadChildren` 的「发起加载」与「加载失败」两个分支此前各写了一份
 * 逐字相同的 `setNodes((prev) => { const next = new Map(prev); if (parentId) { … } return next; })`，
 * 唯一差异是内层 patch（`{ loading: true, error: null }` / `{ loading: false, error: String(err) }`）。
 * `parentId` 为 null（根层）时两者都不写节点，语义保持不变。
 */
function patchParentNode(
  prev: Map<string, TreeNodeState>,
  parentId: string | null,
  patch: Pick<TreeNodeState, "loading" | "error">,
): Map<string, TreeNodeState> {
  const next = new Map(prev);
  if (parentId) {
    const node = next.get(parentId);
    if (node) next.set(parentId, { ...node, ...patch });
  }
  return next;
}

// ---------------------------------------------------------------------------
// State Hook
// ---------------------------------------------------------------------------

/**
 * Tree 的全部状态与数据加载逻辑。抽离自 tree.tsx（源文件超过 500 行红线），
 * 返回的字段即 TreeContext 的值，因此必须与 TreeContextValue 保持一致。
 */
export function useTreeState(opts: {
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

      setNodes((prev) => patchParentNode(prev, parentId, { loading: true, error: null }));

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
        setNodes((prev) => patchParentNode(prev, parentId, { loading: false, error: String(err) }));
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
