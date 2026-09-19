import type * as React from "react";

/**
 * tree 的类型真相来源。
 *
 * 拆分原因：源文件 tree.tsx 超过 500 行红线，按职责把类型集中到此文件，
 * 让 tree.tsx / tree-state.ts / tree-context.ts 共用同一份声明而不互相 import
 * 形成类型环。TreeNodeState、TreeContextValue 属于拆分引入的内部类型，仅在同目录
 * internal/ 内共享，不由 tree.tsx 再导出，公开 API 保持不变。
 *
 * 公开类型（TreeNodeData / ChildrenLoader / NodeState / TreeHandle）由 tree.tsx
 * 原样再导出，消费方仍从 `ui/tree` 入口导入。
 */

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

/**
 * 内部节点记录。childrenIds 为 null 表示「子节点尚未加载」，空数组表示「已确认无子节点」，
 * 这个区别决定了展开时是否触发懒加载。
 */
export interface TreeNodeState {
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

export interface TreeContextValue {
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
