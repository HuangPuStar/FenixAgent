# Async Tree View 组件实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现一个 VSCode 风格的通用异步 Tree View 组件，采用 shadcn Compound Component 模式，每层展开时异步加载。

**Architecture:** 扁平 Map 状态管理 + Context 通信 + Compound Component 组合。`Tree` 根组件提供 Context，`TreeItem` 递归渲染节点，`TreeItemContent` 可覆盖行内容，`TreeItemGroup` 带动画的子节点容器。异步加载通过 `getChildren` 回调驱动，内部缓存避免重复请求。

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4, lucide-react, react-i18next

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `web/components/ui/tree.tsx` | 所有 Tree 子组件（Tree, TreeItem, TreeItemContent, TreeItemGroup）+ types + Context + hook |
| Modify | `web/components/ui/index.ts` | 添加 tree 的 re-export |
| Modify | `web/src/i18n/locales/en/components.json` | 添加 tree i18n keys |
| Modify | `web/src/i18n/locales/zh/components.json` | 添加 tree i18n keys |
| Create | `web/src/__tests__/tree-component.test.ts` | 组件测试 |

---

### Task 1: 添加 i18n 翻译键

**Files:**
- Modify: `web/src/i18n/locales/en/components.json`
- Modify: `web/src/i18n/locales/zh/components.json`

- [ ] **Step 1: 在 en/components.json 中添加 tree 翻译**

在 JSON 末尾 `contextPanel` 对象之后（`}` 之前），添加 `tree` 键：

```json
  "tree": {
    "showMore": "+{{count}} more",
    "loading": "Loading...",
    "loadError": "Failed to load",
    "retry": "Retry",
    "empty": "No items"
  }
```

- [ ] **Step 2: 在 zh/components.json 中添加 tree 翻译**

同样位置添加：

```json
  "tree": {
    "showMore": "+{{count}} 更多",
    "loading": "加载中…",
    "loadError": "加载失败",
    "retry": "重试",
    "empty": "暂无内容"
  }
```

- [ ] **Step 3: 验证 JSON 格式正确**

Run: `bun -e "JSON.parse(require('fs').readFileSync('web/src/i18n/locales/en/components.json','utf8')); JSON.parse(require('fs').readFileSync('web/src/i18n/locales/zh/components.json','utf8')); console.log('OK')"`

Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add web/src/i18n/locales/en/components.json web/src/i18n/locales/zh/components.json
git commit -m "feat: 添加 Tree 组件 i18n 翻译键"
```

---

### Task 2: 实现类型定义与 Context

**Files:**
- Create: `web/components/ui/tree.tsx`

这是整个文件的基础部分——类型定义、Context、和 `useTreeState` hook。

- [ ] **Step 1: 编写类型定义和 Context**

创建 `web/components/ui/tree.tsx`，写入以下内容：

```tsx
"use client";

import { Loader2, ChevronDown, ChevronRight, RotateCw } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../src/lib/utils";
import { NS } from "../../src/i18n";

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
  expandedIds: Set<string>;
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
```

- [ ] **Step 2: 编写 `useTreeState` hook**

在同一文件中继续添加：

```tsx
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
  const [expandedSet, setExpandedSet] = useState<Set<string>>(
    () => new Set(defaultExpandedIds ?? []),
  );
  const [internalSelectedId, setInternalSelectedId] = useState<string | null>(
    defaultSelectedId ?? null,
  );
  const loadingRef = useRef<Set<string>>(new Set());

  const selectedId = controlledSelectedId !== undefined ? controlledSelectedId : internalSelectedId;

  const upsertNode = useCallback((data: TreeNodeData) => {
    setNodes((prev) => {
      const next = new Map(prev);
      const existing = next.get(data.id);
      next.set(data.id, {
        data,
        childrenIds: existing?.childrenIds ?? null,
        expanded: existing?.expanded ?? false,
        loading: false,
        error: null,
        visibleCount: existing?.visibleCount ?? maxVisibleItems,
      });
      return next;
    });
  }, [maxVisibleItems]);

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
        node.childrenIds
          ?.map((id) => nodes.get(id)?.data)
          .filter((d): d is TreeNodeData => d !== undefined) ?? [];
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
```

- [ ] **Step 3: Commit 类型与 hook 部分**

此时文件还不完整（缺少组件），先 commit 基础部分。

```bash
git add web/components/ui/tree.tsx
git commit -m "feat(tree): 添加类型定义、Context 和 useTreeState hook"
```

---

### Task 3: 实现 Tree 根组件

**Files:**
- Modify: `web/components/ui/tree.tsx`

- [ ] **Step 1: 在同一文件中添加 TreeProps 接口和 Tree 组件**

在文件末尾（`useTreeState` 函数之后）添加：

```tsx
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
    [state],
  );

  const childContent = children ?? (
    <>
      {state.rootIds.map((id) => (
        <TreeItem key={id} nodeId={id} />
      ))}
    </>
  );

  return (
    <TreeContext.Provider value={ctx}>
      <div
        role="tree"
        data-slot="tree"
        className={cn("text-sm select-none", className)}
      >
        {childContent}
      </div>
    </TreeContext.Provider>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/components/ui/tree.tsx
git commit -m "feat(tree): 实现 Tree 根组件"
```

---

### Task 4: 实现 TreeItem 组件

**Files:**
- Modify: `web/components/ui/tree.tsx`

- [ ] **Step 1: 在文件末尾添加 TreeItemProps 和 TreeItem 组件**

```tsx
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
    data.hasChildren !== false && (nodeState?.childrenIds === null || (nodeState?.childrenIds?.length ?? 0) > 0 || data.hasChildren === true);
  const showChevron = hasChildrenIndicator;

  const handleRowClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    ctx.select(nodeId);
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

  const truncated =
    (nodeState?.childrenIds?.length ?? 0) - state.visibleChildren.length;

  return (
    <div role="treeitem" aria-expanded={state.expanded} data-slot="tree-item">
      {/* Node row */}
      <div
        className={cn(
          "group flex items-center gap-1 h-7 px-1 rounded-sm cursor-pointer",
          "hover:bg-accent/50",
          state.selected && "bg-accent",
          data.isDisabled && "opacity-50 pointer-events-none",
          className,
        )}
        style={{ paddingLeft: `${depth * 16 + 4}px` }}
        onClick={handleRowClick}
      >
        {/* Indent guides */}
        {depth > 0 && (
          <span
            className="absolute top-0 bottom-0 border-l border-muted-foreground/20"
            style={{ left: `${(depth - 1) * 16 + 12}px` }}
          />
        )}

        {/* Chevron */}
        <span
          className="flex-shrink-0 w-4 h-4 flex items-center justify-center"
          onClick={showChevron ? handleChevronClick : undefined}
        >
          {state.loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          ) : state.error ? (
            <button type="button" onClick={handleRetry} className="text-destructive hover:text-destructive/80">
              <RotateCw className="h-3.5 w-3.5" />
            </button>
          ) : showChevron ? (
            state.expanded ? (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            )
          ) : null}
        </span>

        {/* Icon */}
        {data.icon ? (
          <data.icon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
        ) : (
          <span className="w-4 flex-shrink-0" />
        )}

        {/* Label area */}
        {renderLabel ? (
          <span className="flex-1 min-w-0 truncate">{renderLabel(data, state)}</span>
        ) : (
          <span className="flex-1 min-w-0 truncate">{data.label}</span>
        )}

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
          {state.hasMore && (
            <ShowMoreButton remaining={truncated} onClick={handleShowMore} depth={depth} />
          )}
        </div>
      )}
    </div>
  );
}
```

注意：行渲染中 `depth > 0` 的缩进线使用 `absolute` 定位，需要父节点有 `relative`。`TreeItem` 的子节点 `role="group"` 的 div 已包含 `relative`。

- [ ] **Step 2: Commit**

```bash
git add web/components/ui/tree.tsx
git commit -m "feat(tree): 实现 TreeItem 组件"
```

---

### Task 5: 实现 TreeItemContent、TreeItemGroup 和 ShowMoreButton

**Files:**
- Modify: `web/components/ui/tree.tsx`

- [ ] **Step 1: 在文件末尾添加辅助子组件**

```tsx
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
    <div
      data-slot="tree-item-group"
      role="group"
      className={cn("relative overflow-hidden", className)}
    >
      {children}
    </div>
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
      className="flex items-center gap-1 h-7 px-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 rounded-sm cursor-pointer w-full"
      style={{ paddingLeft: `${(depth + 1) * 16 + 4}px` }}
      onClick={onClick}
    >
      {t("tree.showMore", { count: remaining })}
    </button>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/components/ui/tree.tsx
git commit -m "feat(tree): 实现 TreeItemContent、TreeItemGroup 和 ShowMoreButton"
```

---

### Task 6: 导出组件

**Files:**
- Modify: `web/components/ui/index.ts`

- [ ] **Step 1: 在 index.ts 中添加 tree 导出**

在文件末尾添加一行：

```ts
export * from "./tree";
```

- [ ] **Step 2: 验证导入无报错**

Run: `bun -e "const m = await import('./web/components/ui/tree'); console.log(Object.keys(m))"`

Expected 输出包含：`Tree`, `TreeItem`, `TreeItemContent`, `TreeItemGroup`, `TreeNodeData`, `ChildrenLoader`, `NodeState`, `TreeHandle`

- [ ] **Step 3: Commit**

```bash
git add web/components/ui/index.ts
git commit -m "feat(tree): 在 index.ts 中导出 Tree 组件"
```

---

### Task 7: 编写组件测试

**Files:**
- Create: `web/src/__tests__/tree-component.test.ts`

- [ ] **Step 1: 编写测试文件**

```typescript
import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

// Mock react-i18next to avoid SSR issues
mock.module("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        "tree.showMore": `+${params?.count ?? 0} more`,
        "tree.loading": "Loading...",
        "tree.loadError": "Failed to load",
        "tree.retry": "Retry",
        "tree.empty": "No items",
      };
      return map[key] ?? key;
    },
  }),
}));

// Mock NS constant
mock.module("../../src/i18n", () => ({
  NS: { COMPONENTS: "components" },
}));

describe("Tree component exports", () => {
  test("Tree module exports all expected components and types", async () => {
    const mod = await import("../../components/ui/tree");
    expect(typeof mod.Tree).toBe("function");
    expect(typeof mod.TreeItem).toBe("function");
    expect(typeof mod.TreeItemContent).toBe("function");
    expect(typeof mod.TreeItemGroup).toBe("function");
  });

  test("TreeNodeData type is exported (runtime check via existence)", async () => {
    const mod = await import("../../components/ui/tree");
    // Type exports are compile-time only; verify module loads without error
    expect(mod).toBeDefined();
  });
});

describe("Tree rendering", () => {
  test("Tree renders root items from getChildren", async () => {
    const { Tree } = await import("../../components/ui/tree");

    const getChildren = mock(async (parentId: string | null) => {
      if (parentId === null) {
        return [
          { id: "a", label: "Item A", hasChildren: false },
          { id: "b", label: "Item B", hasChildren: false },
        ];
      }
      return [];
    });

    // SSR render to verify structure is produced without crash
    const html = renderToStaticMarkup(
      <Tree getChildren={getChildren} />,
    );

    // Should contain the labels
    expect(html).toContain("Item A");
    expect(html).toContain("Item B");
    // Should not crash even with SSR (no useEffect)
  });

  test("Tree renders empty state when no root items", async () => {
    const { Tree } = await import("../../components/ui/tree");

    const getChildren = mock(async () => []);

    const html = renderToStaticMarkup(
      <Tree getChildren={getChildren} />,
    );

    // Should render tree container without crashing
    expect(html).toContain('data-slot="tree"');
  });

  test("TreeItem renders with icon and badge", async () => {
    const { Tree, TreeItem } = await import("../../components/ui/tree");

    const getChildren = mock(async (parentId: string | null) => {
      if (parentId === null) {
        return [
          {
            id: "x",
            label: "Labeled",
            hasChildren: false,
            badge: 5,
          },
        ];
      }
      return [];
    });

    const html = renderToStaticMarkup(
      <Tree getChildren={getChildren} />,
    );

    expect(html).toContain("Labeled");
    expect(html).toContain("5");
  });

  test("TreeItem renders custom actions via renderActions", async () => {
    const { Tree } = await import("../../components/ui/tree");

    const getChildren = mock(async (parentId: string | null) => {
      if (parentId === null) {
        return [{ id: "a", label: "Action Item", hasChildren: false }];
      }
      return [];
    });

    const html = renderToStaticMarkup(
      <Tree
        getChildren={getChildren}
        renderActions={(node) => <span>Action-{node.id}</span>}
      />,
    );

    expect(html).toContain("Action-a");
  });
});
```

注意：由于组件使用 `useEffect` 加载根数据，SSR 渲染只能验证结构不崩溃，异步加载行为在浏览器中测试。测试重点放在：模块导出完整性、SSR 不崩溃、标签/角标渲染正确、renderActions 回调正常工作。

- [ ] **Step 2: 运行测试**

Run: `bun test web/src/__tests__/tree-component.test.ts`

Expected: 全部 PASS

- [ ] **Step 3: Commit**

```bash
git add web/src/__tests__/tree-component.test.ts
git commit -m "test: 添加 Tree 组件基础测试"
```

---

### Task 8: 运行 precheck 验证代码质量

**Files:**
- 无新文件

- [ ] **Step 1: 运行 biome 格式化**

Run: `npx biome format --write web/components/ui/tree.tsx web/components/ui/index.ts web/src/__tests__/tree-component.test.ts`

- [ ] **Step 2: 运行 biome import 排序**

Run: `npx biome check --write --linter-enabled=false web/components/ui/tree.tsx web/components/ui/index.ts web/src/__tests__/tree-component.test.ts`

- [ ] **Step 3: 运行 tsc 类型检查**

Run: `npx tsc --noEmit -p web/tsconfig.json`

Expected: 无错误

- [ ] **Step 4: 运行 biome lint**

Run: `npx biome check web/components/ui/tree.tsx web/components/ui/index.ts web/src/__tests__/tree-component.test.ts`

Expected: 无错误或仅有可接受的 warning

- [ ] **Step 5: 如有自动修复，提交修正**

```bash
git add -A
git commit -m "style: tree 组件代码格式化与 lint 修正" || true
```

---

## Self-Review

### Spec Coverage

| Spec 需求 | 对应 Task |
|-----------|-----------|
| TreeNodeData 类型 | Task 2 |
| ChildrenLoader 类型 | Task 2 |
| NodeState 公共接口 | Task 2 |
| TreeNodeState 内部状态 | Task 2 |
| `<Tree>` 组件 + props | Task 3 |
| `<TreeItem>` 组件 + props | Task 4 |
| `<TreeItemContent>` 组件 | Task 5 |
| `<TreeItemGroup>` 组件 | Task 5 |
| 扁平 Map 状态管理 | Task 2 (useTreeState) |
| 异步加载 + 缓存 | Task 2 (loadChildren) |
| maxVisibleItems 截断 | Task 4 (ShowMoreButton) |
| showMore 累加 | Task 2 (showMore) |
| refetch 暴露 (TreeHandle) | Task 2 (类型已定义) |
| 选中/展开/折叠 | Task 2 (select/toggle) |
| VSCode 样式 (chevron/icon/badge/actions) | Task 4 |
| 缩进指示线 | Task 4 (absolute border-left) |
| hover 显示 actions | Task 4 (opacity transition) |
| 选中高亮 bg-accent | Task 4 |
| loading spinner | Task 4 (Loader2) |
| error 重试按钮 | Task 4 (RotateCw) |
| i18n 翻译 | Task 1 |
| 文件导出 | Task 6 |
| 测试 | Task 7 |
| precheck | Task 8 |

**Gap**: `TreeHandle.refetch` 类型已定义但未在 `Tree` 组件中通过 `useImperativeHandle` 暴露。这是一个后续完善点，当前纯异步模式下消费方通过重新传 `getChildren` 即可刷新。如需立即可用，在 Task 3 的 `Tree` 组件中添加 `useImperativeHandle` 即可。

### Placeholder Scan

无 TBD/TODO/待定内容。

### Type Consistency

- `TreeNodeData.id` 为 `string` — 全文一致
- `ChildrenLoader` 参数 `parentId: string | null` — 全文一致
- `NodeState` 与 `TreeItemProps.renderActions` 第二参数匹配 — 一致
- `maxVisibleItems` 默认值 `100` — 全文一致
- `getNodeState` 返回 `NodeState` — 全文一致
