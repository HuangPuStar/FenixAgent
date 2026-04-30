import { useState, useMemo, useEffect } from "react";
import { ChevronRight, ChevronDown, Search } from "lucide-react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getExpandedRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
  type ExpandedState,
} from "@tanstack/react-table";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "../ui/table";
import { Checkbox } from "../ui/checkbox";
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

export interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  searchable?: boolean;
  searchPlaceholder?: string;
  selectable?: boolean;
  onSelectionChange?: (selected: T[]) => void;
  actions?: (row: T) => React.ReactNode;
  expandableRow?: (row: T) => React.ReactNode;
  rowKey?: RowKeyGetter<T>;
  defaultExpandAll?: boolean;
  emptyMessage?: string;
  pageSize?: number;
  expandedState?: ExpandedState;
  onExpandedChange?: (expanded: ExpandedState) => void;
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

export function buildInitialExpandedState<T>(data: T[], rowKey?: RowKeyGetter<T>): ExpandedState {
  const initial: ExpandedState = {};
  data.forEach((row, index) => {
    const rowId = rowKey ? rowKey(row) : String(index);
    initial[rowId] = true;
  });
  return initial;
}

function buildColumnDefs<T>(
  columns: Column<T>[],
  selectable: boolean,
  expandableRow: ((row: T) => React.ReactNode) | undefined,
  actions: ((row: T) => React.ReactNode) | undefined,
): ColumnDef<T>[] {
  const defs: ColumnDef<T>[] = [];

  if (expandableRow) {
    defs.push({
      id: "expand",
      size: 40,
      header: "",
      cell: () => null,
    });
  }

  if (selectable) {
    defs.push({
      id: "select",
      size: 40,
      header: ({ table }) => (
        <Checkbox
          checked={table.getRowModel().rows.length > 0 && table.getIsAllPageRowsSelected()}
          onCheckedChange={(checked) => {
            table.toggleAllPageRowsSelected(!!checked);
          }}
        />
      ),
      cell: ({ row }) => (
        <Checkbox
          checked={row.getIsSelected()}
          onCheckedChange={(checked) => {
            row.toggleSelected(!!checked);
          }}
        />
      ),
    });
  }

  columns.forEach((col) => {
    defs.push({
      accessorKey: col.key,
      header: col.header,
      enableSorting: col.sortable ?? false,
      cell: ({ row }) => {
        return col.render
          ? col.render(row.original)
          : String((row.original as Record<string, unknown>)[col.key] ?? "—");
      },
    });
  });

  if (actions) {
    defs.push({
      id: "actions",
      header: "操作",
      cell: ({ row }) => actions(row.original),
    });
  }

  return defs;
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
  defaultExpandAll,
  expandedState: controlledExpanded,
  onExpandedChange,
}: DataTableProps<T>) {
  const [globalFilter, setGlobalFilter] = useState("");
  const [sorting, setSorting] = useState<SortingState>([]);
  const [internalExpanded, setInternalExpanded] = useState<ExpandedState>(() => {
    if (!defaultExpandAll) return {};
    return buildInitialExpandedState(data, rowKey);
  });
  const expanded = controlledExpanded !== undefined ? controlledExpanded : internalExpanded;
  const setExpanded = onExpandedChange ?? setInternalExpanded;
  const [rowSelection, setRowSelection] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!defaultExpandAll) return;
    setExpanded((prev) => {
      const next: ExpandedState = {};
      data.forEach((row, index) => {
        const rowId = rowKey ? rowKey(row) : String(index);
        next[rowId] = prev[rowId] !== undefined ? prev[rowId] : true;
      });
      return next;
    });
  }, [data, rowKey, defaultExpandAll]);

  const globalFilterFn = useMemo(() => {
    return (row: { original: T }, _columnId: string, filterValue: string) => {
      if (!filterValue.trim()) return true;
      const q = filterValue.toLowerCase();
      return columns
        .filter((c) => c.filterable)
        .some((col) => {
          const val = (row.original as Record<string, unknown>)[col.key];
          return val != null && String(val).toLowerCase().includes(q);
        });
    };
  }, [columns]);

  const table = useReactTable({
    data,
    columns: useMemo(
      () => buildColumnDefs(columns, !!selectable, expandableRow, actions),
      [columns, selectable, expandableRow, actions]
    ),
    state: {
      sorting,
      globalFilter,
      expanded,
      rowSelection,
      pagination: { pageIndex: 0, pageSize },
    },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onExpandedChange: setExpanded,
    onRowSelectionChange: setRowSelection,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    globalFilterFn,
    getRowId: rowKey
      ? (row) => rowKey(row as T)
      : (row, index) => String(index),
    enableGlobalFilter: searchable,
    manualPagination: false,
    autoResetPageIndex: true,
  });

  useMemo(() => {
    if (!onSelectionChange) return;
    const selectedRows = table.getSelectedRowModel().rows.map((r) => r.original);
    onSelectionChange(selectedRows);
  }, [rowSelection, onSelectionChange, table]);

  const colSpan = columns.length + (selectable ? 1 : 0) + (actions ? 1 : 0) + (expandableRow ? 1 : 0);

  return (
    <div className="space-y-3">
      {searchable && (
        <Input
          value={globalFilter}
          onChange={(e) => setGlobalFilter(e.target.value)}
          placeholder={searchPlaceholder || "搜索..."}
          className="max-w-sm"
        />
      )}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className="border-b bg-muted/50">
                {headerGroup.headers.map((header) => {
                  const isSortable = header.column.getCanSort();
                  const sortDir = header.column.getIsSorted();
                  return (
                    <TableHead
                      key={header.id}
                      className="px-3 py-2 text-left font-medium text-muted-foreground cursor-pointer select-none"
                      onClick={isSortable ? header.column.getToggleSortingHandler() : undefined}
                      style={{ width: header.getSize() !== 150 ? header.getSize() : undefined }}
                    >
                      <div className="flex items-center gap-1">
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {isSortable && sortDir === "asc" && " ↑"}
                        {isSortable && sortDir === "desc" && " ↓"}
                      </div>
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={colSpan} className="py-8 text-center text-muted-foreground">
                  {emptyMessage}
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => {
                const rowId = row.id;
                const isExpanded = row.getIsExpanded();
                return (
                  <Collapsible key={rowId} open={isExpanded} onOpenChange={() => row.toggleExpanded()} asChild>
                    <>
                      <TableRow className="group border-b hover:bg-surface-hover transition-colors relative table-row-hover">
                        {row.getVisibleCells().map((cell) => {
                          if (cell.column.id === "expand" && expandableRow) {
                            return (
                              <TableCell key={cell.id} className="w-10 px-2 py-2">
                                <CollapsibleTrigger asChild>
                                  <button className="p-0.5 rounded hover:bg-muted">
                                    {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                                  </button>
                                </CollapsibleTrigger>
                              </TableCell>
                            );
                          }
                          return (
                            <TableCell key={cell.id} className="px-3 py-2">
                              {flexRender(cell.column.columnDef.cell, cell.getContext())}
                            </TableCell>
                          );
                        })}
                      </TableRow>
                      {expandableRow && (
                        <TableRow className="border-b">
                          <TableCell colSpan={colSpan} className="p-0">
                            <CollapsibleContent>
                              <div className="px-6 py-3 bg-muted/30">
                                {expandableRow(row.original)}
                              </div>
                            </CollapsibleContent>
                          </TableCell>
                        </TableRow>
                      )}
                    </>
                  </Collapsible>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
      {table.getPageCount() > 1 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            第 {(table.getState().pagination.pageIndex) * pageSize + 1}-{Math.min((table.getState().pagination.pageIndex + 1) * pageSize, table.getFilteredRowModel().rows.length)} 条，共 {table.getFilteredRowModel().rows.length} 条
          </span>
          <div className="flex gap-1">
            <Button size="sm" variant="outline" disabled={!table.getCanPreviousPage()} onClick={() => table.previousPage()}>上一页</Button>
            <Button size="sm" variant="outline" disabled={!table.getCanNextPage()} onClick={() => table.nextPage()}>下一页</Button>
          </div>
        </div>
      )}
    </div>
  );
}
