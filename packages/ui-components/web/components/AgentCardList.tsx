import { Search } from "lucide-react";
import type * as React from "react";
import { Fragment, useState } from "react";

interface AgentCardListProps<T> {
  items: T[];
  cardKey: (item: T) => string;
  renderCard: (item: T, isSelected: boolean, toggleSelect: () => void) => React.ReactNode;
  searchPlaceholder?: string;
  searchFn?: (item: T, query: string) => boolean;
  emptyMessage?: string;
  selectable?: boolean;
  selectedItems?: T[];
  onSelectionChange?: (items: T[]) => void;
  batchActions?: React.ReactNode;
  /** Grid column class, e.g. "grid-cols-2 md:grid-cols-3 lg:grid-cols-4". Defaults to single column list. */
  gridCols?: string;
}

/**
 * 源实现的硬编码色值（#98a8bd / #dce5ef / #1a2944 / #99a8bc / #1677ff / #e8edf4 / bg-white）已替换为
 * 包内 token（text-muted / border / text-bright / brand / surface-1），视觉意图不变并支持主题切换。
 *
 * 已知限制：工具栏与空态文案硬编码为英文默认值，`emptyMessage` / `searchPlaceholder` 可由 props 覆盖，
 * `{n} selected` / `Clear` / `Select all` 没有覆盖入口，本包也不自带 i18n 单例可读取。
 * 影响范围：仅本组件的搜索栏、批量选择栏与空态展示；卡片内部由调用方 renderCard 决定，不受影响。
 * 移除条件：上述固定文案改为 props 或 UI_COMPONENTS_NS 下的 i18n 键之后，删除本注释。
 */
export function AgentCardList<T>({
  items,
  cardKey,
  renderCard,
  searchPlaceholder,
  searchFn,
  emptyMessage = "No items",
  selectable = false,
  selectedItems = [],
  onSelectionChange,
  batchActions,
  gridCols,
}: AgentCardListProps<T>) {
  const [searchQuery, setSearchQuery] = useState("");

  const filtered =
    searchQuery.trim() && searchFn ? items.filter((item) => searchFn(item, searchQuery.toLowerCase())) : items;

  const selectedSet = new Set(selectedItems.map(cardKey));

  const toggleSelect = (item: T) => {
    if (!onSelectionChange) return;
    const key = cardKey(item);
    if (selectedSet.has(key)) {
      onSelectionChange(selectedItems.filter((s) => cardKey(s) !== key));
    } else {
      onSelectionChange([...selectedItems, item]);
    }
  };

  const toggleSelectAll = () => {
    if (!onSelectionChange) return;
    if (selectedItems.length === filtered.length) {
      onSelectionChange([]);
    } else {
      onSelectionChange([...filtered]);
    }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      {/* 搜索栏 + 批量操作 */}
      {(searchPlaceholder || (selectable && selectedItems.length > 0)) && (
        <div className="flex items-center gap-3 px-6 py-3">
          {searchPlaceholder && (
            <div className="relative w-full max-w-md">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={searchPlaceholder}
                className="h-10 w-full rounded-lg border border-border bg-surface-1 pl-10 pr-4 text-[13px] text-text-bright outline-none transition placeholder:text-text-muted focus:border-brand focus:ring-4 focus:ring-brand/10"
              />
            </div>
          )}
          {selectable && selectedItems.length > 0 && (
            <div className="flex items-center gap-2 ml-auto">
              <span className="text-xs text-text-muted">{selectedItems.length} selected</span>
              <button
                type="button"
                onClick={() => onSelectionChange?.([])}
                className="text-xs text-text-muted hover:text-text-bright"
              >
                Clear
              </button>
              {batchActions}
            </div>
          )}
        </div>
      )}

      {/* 全选栏 */}
      {selectable && filtered.length > 0 && (
        <div className="flex items-center gap-3 px-6 py-2 border-b border-border bg-surface-1">
          <input
            type="checkbox"
            checked={selectedItems.length === filtered.length && filtered.length > 0}
            onChange={toggleSelectAll}
            className="rounded border-border"
          />
          <span className="text-xs text-text-muted">Select all ({filtered.length})</span>
        </div>
      )}

      {/* 卡片列表 */}
      <div className="flex-1 overflow-y-auto py-4">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-text-muted">
            <p className="text-sm">{emptyMessage}</p>
          </div>
        ) : (
          <div className={`grid gap-3 ${gridCols ?? ""}`}>
            {filtered.map((item) => (
              // 修复 `packages/resources/prod-view/README.md`「已知项」里登记的
              // 「AgentCardList 内部列表缺 key（非本包缺陷）」：原实现直接返回 renderCard 的结果，
              // 列表项拿不到 key，渲染有数据的列表时 React 会打印 "Each child in a list should have a
              // unique \"key\" prop"。这里按该条给出的移除条件补 `key={cardKey(item)}`；卡片 DOM 由
              // 调用方 renderCard 决定，Fragment 不产生节点，渲染结果与原先一致。
              <Fragment key={cardKey(item)}>
                {renderCard(item, selectedSet.has(cardKey(item)), () => toggleSelect(item))}
              </Fragment>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
