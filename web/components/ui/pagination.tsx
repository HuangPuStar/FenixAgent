import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback } from "react";
import { Button } from "./button";

interface PaginationProps {
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  /** 翻译函数 */
  t: (key: string, opts?: Record<string, unknown>) => string;
}

const PAGE_SIZES = [20, 50, 100];

export function Pagination({ page, totalPages, total, pageSize, onPageChange, onPageSizeChange, t }: PaginationProps) {
  // 生成页码列表（含省略号）
  const getPageNumbers = useCallback((): (number | "ellipsis")[] => {
    if (totalPages <= 7) {
      return Array.from({ length: totalPages }, (_, i) => i + 1);
    }
    const pages: (number | "ellipsis")[] = [1];
    if (page > 3) pages.push("ellipsis");
    const start = Math.max(2, page - 1);
    const end = Math.min(totalPages - 1, page + 1);
    for (let i = start; i <= end; i++) pages.push(i);
    if (page < totalPages - 2) pages.push("ellipsis");
    pages.push(totalPages);
    return pages;
  }, [page, totalPages]);

  if (totalPages <= 1 && total <= pageSize) return null;

  const pageNumbers = getPageNumbers();

  return (
    <div className="flex items-center justify-between gap-4 py-3">
      {/* 左侧：总数 + pageSize 切换 */}
      <div className="flex items-center gap-3">
        <span className="text-xs text-muted-foreground">{t("runs.pagination_total", { total })}</span>
        {onPageSizeChange && (
          <select
            value={pageSize}
            onChange={(e) => {
              onPageSizeChange(Number(e.target.value));
              onPageChange(1);
            }}
            className="h-7 rounded-md border bg-background px-2 text-xs text-muted-foreground"
          >
            {PAGE_SIZES.map((s) => (
              <option key={s} value={s}>
                {t("runs.pagination_page_size", { size: s })}
              </option>
            ))}
          </select>
        )}
      </div>
      {/* 右侧：页码按钮 */}
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="xs" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
          <ChevronLeft size={14} />
        </Button>
        {pageNumbers.map((p, idx) =>
          p === "ellipsis" ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: ellipsis separators are static, no reordering
            <span key={`e-${idx}`} className="px-1 text-xs text-muted-foreground">
              ...
            </span>
          ) : (
            <Button
              key={p}
              variant={p === page ? "default" : "ghost"}
              size="xs"
              onClick={() => onPageChange(p)}
              className="min-w-7"
            >
              {p}
            </Button>
          ),
        )}
        <Button variant="ghost" size="xs" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>
          <ChevronRight size={14} />
        </Button>
      </div>
    </div>
  );
}
