import { Search } from "lucide-react";
import { useState } from "react";

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
              <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[#98a8bd]" />
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={searchPlaceholder}
                className="h-10 w-full rounded-lg border border-[#dce5ef] bg-white pl-10 pr-4 text-[13px] text-[#1a2944] outline-none transition placeholder:text-[#99a8bc] focus:border-[#1677ff] focus:ring-4 focus:ring-[#1677ff]/10"
              />
            </div>
          )}
          {selectable && selectedItems.length > 0 && (
            <div className="flex items-center gap-2 ml-auto">
              <span className="text-xs text-[#94a3b8]">{selectedItems.length} selected</span>
              <button
                type="button"
                onClick={() => onSelectionChange?.([])}
                className="text-xs text-[#94a3b8] hover:text-[#1a2944]"
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
        <div className="flex items-center gap-3 px-6 py-2 border-b border-[#e8edf4] bg-surface-1">
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
            {filtered.map((item) => renderCard(item, selectedSet.has(cardKey(item)), () => toggleSelect(item)))}
          </div>
        )}
      </div>
    </div>
  );
}
