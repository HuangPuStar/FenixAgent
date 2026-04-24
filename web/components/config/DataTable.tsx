import { useState, useMemo } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";

export interface Column<T> {
  key: string;
  header: string;
  sortable?: boolean;
  filterable?: boolean;
  render?: (row: T) => React.ReactNode;
}

export type RowKeyGetter<T> = (row: T) => string;

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  searchable?: boolean;
  searchPlaceholder?: string;
  selectable?: boolean;
  onSelectionChange?: (selected: T[]) => void;
  actions?: (row: T) => React.ReactNode;
  expandableRow?: (row: T) => React.ReactNode;
  rowKey?: RowKeyGetter<T>;
  emptyMessage?: string;
  pageSize?: number;
}

export function filterData<T>(data: T[], columns: Column<T>[], search: string): T[] {
  if (!search.trim()) return data;
  const q = search.toLowerCase();
  return data.filter((row) =>
    columns
      .filter((c) => c.filterable)
      .some((col) => {
        const val = (row as Record<string, unknown>)[col.key];
        return val != null && String(val).toLowerCase().includes(q);
      })
  );
}

export function sortData<T>(data: T[], key: string, dir: "asc" | "desc"): T[] {
  return [...data].sort((a, b) => {
    const va = (a as Record<string, unknown>)[key];
    const vb = (b as Record<string, unknown>)[key];
    let cmp = 0;
    if (typeof va === "string" && typeof vb === "string") {
      cmp = va.localeCompare(vb);
    } else if (typeof va === "number" && typeof vb === "number") {
      cmp = va - vb;
    } else {
      cmp = String(va ?? "").localeCompare(String(vb ?? ""));
    }
    return dir === "desc" ? -cmp : cmp;
  });
}

export function paginateData<T>(data: T[], page: number, size: number): { items: T[]; total: number } {
  const start = (page - 1) * size;
  return { items: data.slice(start, start + size), total: data.length };
}

export function DataTable<T>({
  columns,
  data,
  searchable,
  searchPlaceholder,
  selectable,
  onSelectionChange,
  actions,
  expandableRow,
  rowKey,
  emptyMessage = "暂无数据",
  pageSize = 10,
}: DataTableProps<T>) {
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(1);
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());

  const processed = useMemo(() => {
    let result = filterData(data, columns, search);
    if (sortKey) result = sortData(result, sortKey, sortDir);
    return result;
  }, [data, columns, search, sortKey, sortDir]);

  const { items, total } = paginateData(processed, page, pageSize);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
    setPage(1);
  };

  const toggleSelectAll = () => {
    if (selectedIndices.size === items.length && items.length > 0) {
      setSelectedIndices(new Set());
      onSelectionChange?.([]);
    } else {
      const all = new Set(items.map((_, i) => i));
      setSelectedIndices(all);
      onSelectionChange?.(items);
    }
  };

  const toggleSelect = (idx: number) => {
    const next = new Set(selectedIndices);
    if (next.has(idx)) next.delete(idx);
    else next.add(idx);
    setSelectedIndices(next);
    onSelectionChange?.(items.filter((_, i) => next.has(i)));
  };

  const toggleExpand = (key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const colSpan = columns.length + (selectable ? 1 : 0) + (actions ? 1 : 0) + (expandableRow ? 1 : 0);

  return (
    <div className="space-y-3">
      {searchable && (
        <Input
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          placeholder={searchPlaceholder || "搜索..."}
          className="max-w-sm"
        />
      )}
      <div className="rounded-md border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              {expandableRow && <th className="w-10 px-2 py-2"></th>}
              {selectable && (
                <th className="w-10 px-3 py-2">
                  <input
                    type="checkbox"
                    checked={items.length > 0 && selectedIndices.size === items.length}
                    onChange={toggleSelectAll}
                  />
                </th>
              )}
              {columns.map((col) => (
                <th
                  key={col.key}
                  className="px-3 py-2 text-left font-medium text-muted-foreground cursor-pointer select-none"
                  onClick={col.sortable ? () => handleSort(col.key) : undefined}
                >
                  {col.header}
                  {col.sortable && sortKey === col.key && (sortDir === "asc" ? " ↑" : " ↓")}
                </th>
              ))}
              {actions && <th className="px-3 py-2 text-left font-medium text-muted-foreground">操作</th>}
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={colSpan} className="py-8 text-center text-muted-foreground">
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              items.map((row, i) => {
                const key = rowKey ? rowKey(row) : String(i);
                const isExpanded = expandedKeys.has(key);
                return (
                  <Collapsible key={key} open={isExpanded} onOpenChange={() => toggleExpand(key)} asChild>
                    <>
                      <tr className="border-b hover:bg-muted/50">
                        {expandableRow && (
                          <td className="w-10 px-2 py-2">
                            <CollapsibleTrigger asChild>
                              <button className="p-0.5 rounded hover:bg-muted">
                                {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                              </button>
                            </CollapsibleTrigger>
                          </td>
                        )}
                        {selectable && (
                          <td className="w-10 px-3 py-2">
                            <input
                              type="checkbox"
                              checked={selectedIndices.has(i)}
                              onChange={() => toggleSelect(i)}
                            />
                          </td>
                        )}
                        {columns.map((col) => (
                          <td key={col.key} className="px-3 py-2">
                            {col.render ? col.render(row) : String((row as Record<string, unknown>)[col.key] ?? "—")}
                          </td>
                        ))}
                        {actions && <td className="px-3 py-2">{actions(row)}</td>}
                      </tr>
                      {expandableRow && (
                        <tr className="border-b">
                          <td colSpan={colSpan} className="p-0">
                            <CollapsibleContent>
                              <div className="px-6 py-3 bg-muted/30">
                                {expandableRow(row)}
                              </div>
                            </CollapsibleContent>
                          </td>
                        </tr>
                      )}
                    </>
                  </Collapsible>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {total > pageSize && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            第 {(page - 1) * pageSize + 1}-{Math.min(page * pageSize, total)} 条，共 {total} 条
          </span>
          <div className="flex gap-1">
            <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</Button>
            <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>下一页</Button>
          </div>
        </div>
      )}
    </div>
  );
}
