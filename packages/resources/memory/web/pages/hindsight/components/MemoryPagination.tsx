import { Button } from "@fenix/ui-components/ui/button";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import type { ReactNode } from "react";

/**
 * 记忆视图的分页条 —— 表格视图与实体列表此前各写一份逐字相同的实现（四按钮 + 页码，连 `h-7 w-7 p-0`
 * 的按钮尺寸与 `gap-1` 容器都一样）。两份唯一真正的差异是左侧区间文案的计数口径与「取数中禁止翻页」，
 * 因此这里只收这两项，其余照抄迁移前的那一份。
 *
 * 为什么不收时间线视图的组导航：它是另一套交互——按钮用 `secondary` 变体、按分组**滚动定位**而不是
 * 换页，页码两侧还有独立的边框与更小的字号，禁用条件也按「分组数 / 当前分组下标」判断。形态相近但语义
 * 不同，强行合并只会把两套判断塞进一组 props。
 */
export interface MemoryPaginationProps {
  currentPage: number;
  totalPages: number;
  /** 翻页回调：组件只发目标页码，不持有状态。 */
  onPageChange: (page: number) => void;
  /** 左侧区间文案（各视图的计数口径不同：表格用筛选后的行数、实体列表用总数）。 */
  rangeLabel: ReactNode;
  /** 取数中禁止翻页（实体列表传 `loading`；表格视图没有这个状态）。 */
  disabled?: boolean;
}

export function MemoryPagination({
  currentPage,
  totalPages,
  onPageChange,
  rangeLabel,
  disabled = false,
}: MemoryPaginationProps) {
  // 单页时不渲染：与两个视图迁移前的 `totalPages > 1 &&` 判断一致。
  if (totalPages <= 1) return null;

  const atFirstPage = disabled || currentPage === 1;
  const atLastPage = disabled || currentPage === totalPages;

  return (
    <div className="flex items-center justify-between mt-3 pt-3 border-t">
      <div className="text-xs text-muted-foreground">{rangeLabel}</div>
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(1)}
          disabled={atFirstPage}
          className="h-7 w-7 p-0"
        >
          <ChevronsLeft className="h-3 w-3" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(currentPage - 1)}
          disabled={atFirstPage}
          className="h-7 w-7 p-0"
        >
          <ChevronLeft className="h-3 w-3" />
        </Button>
        <span className="text-xs px-2">
          {currentPage} / {totalPages}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(currentPage + 1)}
          disabled={atLastPage}
          className="h-7 w-7 p-0"
        >
          <ChevronRight className="h-3 w-3" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(totalPages)}
          disabled={atLastPage}
          className="h-7 w-7 p-0"
        >
          <ChevronsRight className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}
