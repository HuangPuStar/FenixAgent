import { Search } from "lucide-react";
import { useState } from "react";
import { Input } from "@/components/ui/input";

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
      {/* Search + Batch Actions */}
      {(searchPlaceholder || (selectable && selectedItems.length > 0)) && (
        <div className="flex items-center gap-3 px-6 py-3 border-b border-border-subtle">
          {searchPlaceholder && (
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-text-muted" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={searchPlaceholder}
                className="pl-9 h-8 text-sm"
              />
            </div>
          )}
          {selectable && selectedItems.length > 0 && (
            <div className="flex items-center gap-2 ml-auto">
              <span className="text-xs text-text-muted">{selectedItems.length} selected</span>
              <button
                type="button"
                onClick={() => onSelectionChange?.([])}
                className="text-xs text-text-muted hover:text-text-primary"
              >
                Clear
              </button>
              {batchActions}
            </div>
          )}
        </div>
      )}

      {/* Select All */}
      {selectable && filtered.length > 0 && (
        <div className="flex items-center gap-3 px-6 py-2 border-b border-border-subtle bg-surface-1">
          <input
            type="checkbox"
            checked={selectedItems.length === filtered.length && filtered.length > 0}
            onChange={toggleSelectAll}
            className="rounded border-border"
          />
          <span className="text-xs text-text-muted">Select all ({filtered.length})</span>
        </div>
      )}

      {/* Card List */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
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
