import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { Button } from "@fenix/ui-components/ui/button";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { Calendar, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, ZoomIn, ZoomOut } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { GraphApiData, MemoryTableRow } from "../types";

/**
 * `DataView` 的时间线视图：按粒度（年 / 月 / 周 / 日）分组的记忆条目流，带缩放与组间跳转。
 *
 * 从 `DataView` 抽出：它与表格 / 图谱并列、彼此不共享渲染，粒度与当前组的游标也都是它自持的
 * （切视图即卸载，与页面无关）。分组口径（含「周」这一档的键与标签算法）就地留在本文件——
 * 只有这一个消费方，按「抽象延迟到第二个真实用例」先不单开模型层。
 */
type Granularity = "year" | "month" | "week" | "day";

export interface DataViewTimelineProps {
  /** 迁移前该 props 就未被使用（时间线只读 `filteredRows`），保留以免改口调用方。 */
  _data: GraphApiData;
  filteredRows: MemoryTableRow[];
  onMemoryClick: (id: string) => void;
}

export function DataViewTimeline({ _data, filteredRows, onMemoryClick }: DataViewTimelineProps) {
  const { t } = useTranslation(NS.HINDSIGHT);
  const [granularity, setGranularity] = useState<Granularity>("month");
  const [currentIndex, setCurrentIndex] = useState(0);

  // 过滤并按日期排序
  const { sortedItems, itemsWithoutDates } = useMemo(() => {
    if (!filteredRows || filteredRows.length === 0) return { sortedItems: [], itemsWithoutDates: [] };
    const withDates = filteredRows
      .filter((row) => row.occurred_start)
      .sort((a, b) => new Date(a.occurred_start!).getTime() - new Date(b.occurred_start!).getTime());
    const withoutDates = filteredRows.filter((row) => !row.occurred_start);
    return { sortedItems: withDates, itemsWithoutDates: withoutDates };
  }, [filteredRows]);

  // 按粒度分组
  const timelineGroups = useMemo(() => {
    if (sortedItems.length === 0) return [];

    const getGroupKey = (date: Date): string => {
      const year = date.getFullYear();
      const month = date.getMonth();
      const day = date.getDate();
      switch (granularity) {
        case "year":
          return `${year}`;
        case "month":
          return `${year}-${String(month + 1).padStart(2, "0")}`;
        case "week": {
          const startOfWeek = new Date(date);
          startOfWeek.setDate(day - date.getDay());
          return `${startOfWeek.getFullYear()}-W${String(Math.ceil(startOfWeek.getDate() / 7)).padStart(2, "0")}-${String(startOfWeek.getMonth() + 1).padStart(2, "0")}-${String(startOfWeek.getDate()).padStart(2, "0")}`;
        }
        case "day":
          return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      }
    };

    const getGroupLabel = (key: string, date: Date): string => {
      switch (granularity) {
        case "year":
          return key;
        case "month":
          return date.toLocaleDateString(undefined, { year: "numeric", month: "short" });
        case "week": {
          const endOfWeek = new Date(date);
          endOfWeek.setDate(date.getDate() + 6);
          return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} - ${endOfWeek.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
        }
        case "day":
          return date.toLocaleDateString(undefined, {
            weekday: "short",
            month: "short",
            day: "numeric",
            year: "numeric",
          });
      }
    };

    const groups: { [key: string]: { items: MemoryTableRow[]; date: Date } } = {};
    sortedItems.forEach((row) => {
      const date = new Date(row.occurred_start!);
      const key = getGroupKey(date);
      if (!groups[key]) {
        let groupDate = date;
        if (granularity === "week") {
          const parts = key.split("-");
          groupDate = new Date(parseInt(parts[0], 10), parseInt(parts[2], 10) - 1, parseInt(parts[3], 10));
        }
        groups[key] = { items: [], date: groupDate };
      }
      groups[key].items.push(row);
    });

    return Object.entries(groups)
      .sort(([, a], [, b]) => a.date.getTime() - b.date.getTime())
      .map(([key, { items, date }]) => ({ key, label: getGroupLabel(key, date), items, date }));
  }, [sortedItems, granularity]);

  const scrollToGroup = (index: number) => {
    const clampedIndex = Math.max(0, Math.min(index, timelineGroups.length - 1));
    setCurrentIndex(clampedIndex);
    const element = document.getElementById(`timeline-group-${clampedIndex}`);
    element?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const zoomIn = () => {
    const levels: Granularity[] = ["year", "month", "week", "day"];
    const currentIdx = levels.indexOf(granularity);
    if (currentIdx < levels.length - 1) {
      setGranularity(levels[currentIdx + 1]);
    }
  };

  const zoomOut = () => {
    const levels: Granularity[] = ["year", "month", "week", "day"];
    const currentIdx = levels.indexOf(granularity);
    if (currentIdx > 0) {
      setGranularity(levels[currentIdx - 1]);
    }
  };

  if (sortedItems.length === 0) {
    return (
      <EmptyState
        className="py-12"
        icon={<Calendar />}
        title={t("dataView.noTimelineData")}
        description={t("dataView.noTimelineDataDescription")}
      />
    );
  }

  const granularityLabels: Record<Granularity, string> = {
    year: t("dataView.granularityYear"),
    month: t("dataView.granularityMonth"),
    week: t("dataView.granularityWeek"),
    day: t("dataView.granularityDay"),
  };

  return (
    <div className="px-4">
      {/* 控制栏 */}
      <div className="flex items-center justify-between mb-3 gap-4">
        <div className="text-xs text-muted-foreground">
          {t("dataView.timelineMemoriesCount", { count: sortedItems.length })}
          {itemsWithoutDates.length > 0 &&
            ` ${t("dataView.timelineWithoutDates", { count: itemsWithoutDates.length })}`}
        </div>

        <div className="flex items-center gap-1">
          {/* 缩放 */}
          <div className="flex items-center border border-border rounded mr-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={zoomOut}
              disabled={granularity === "year"}
              className="h-7 w-7 p-0"
              title={t("dataView.zoomOut")}
            >
              <ZoomOut className="h-3 w-3" />
            </Button>
            <span className="text-3xs px-2 min-w-12.5 text-center border-x border-border text-foreground">
              {granularityLabels[granularity]}
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={zoomIn}
              disabled={granularity === "day"}
              className="h-7 w-7 p-0"
              title={t("dataView.zoomIn")}
            >
              <ZoomIn className="h-3 w-3" />
            </Button>
          </div>

          {/* 导航 */}
          <div className="flex items-center border border-border rounded">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => scrollToGroup(0)}
              disabled={timelineGroups.length <= 1}
              className="h-7 w-7 p-0"
            >
              <ChevronsLeft className="h-3 w-3" />
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => scrollToGroup(currentIndex - 1)}
              disabled={currentIndex === 0}
              className="h-7 w-7 p-0"
            >
              <ChevronLeft className="h-3 w-3" />
            </Button>
            <span className="text-3xs px-2 min-w-15 text-center border-x border-border text-foreground">
              {currentIndex + 1} / {timelineGroups.length}
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => scrollToGroup(currentIndex + 1)}
              disabled={currentIndex >= timelineGroups.length - 1}
              className="h-7 w-7 p-0"
            >
              <ChevronRight className="h-3 w-3" />
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => scrollToGroup(timelineGroups.length - 1)}
              disabled={timelineGroups.length <= 1}
              className="h-7 w-7 p-0"
            >
              <ChevronsRight className="h-3 w-3" />
            </Button>
          </div>
        </div>
      </div>

      {/* 时间线条目 */}
      <div className="relative max-h-137.5 overflow-y-auto pr-2">
        <div className="absolute left-15 top-0 bottom-0 w-0.5 bg-border" />
        {timelineGroups.map((group, groupIdx) => (
          <div key={group.key} id={`timeline-group-${groupIdx}`} className="mb-4">
            {/* 分组头 */}
            <div
              className="flex items-center mb-2 cursor-pointer hover:opacity-80"
              onClick={() => setCurrentIndex(groupIdx)}
            >
              <div className="w-15 text-right pr-3">
                <span className="text-xs font-semibold text-primary">{group.label}</span>
              </div>
              <div className="w-2 h-2 rounded-full bg-primary z-10" />
              <span className="ml-2 text-3xs text-muted-foreground">
                {group.items.length}{" "}
                {group.items.length === 1 ? t("dataView.timelineItem") : t("dataView.timelineItems")}
              </span>
            </div>

            {/* 条目列表 */}
            <div className="space-y-1">
              {group.items.map((item: MemoryTableRow, idx: number) => (
                <div
                  key={item.id || idx}
                  onClick={() => onMemoryClick(item.id)}
                  className="flex items-start cursor-pointer group hover:opacity-80"
                >
                  <div className="w-15 text-right pr-3 pt-1 flex-shrink-0">
                    <div className="text-3xs text-muted-foreground">
                      {new Date(item.occurred_start!).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      })}
                    </div>
                    <div className="text-3xs text-muted-foreground/70">
                      {new Date(item.occurred_start!).toLocaleTimeString(undefined, {
                        hour: "2-digit",
                        minute: "2-digit",
                        hour12: false,
                      })}
                    </div>
                  </div>
                  <div className="flex-shrink-0 pt-2">
                    <div className="w-1.5 h-1.5 rounded-full z-10 bg-muted-foreground/50 group-hover:bg-primary" />
                  </div>
                  <div className="ml-3 flex-1 p-2 rounded border transition-colors bg-card border-border hover:border-primary/50">
                    <p className="text-xs text-foreground line-clamp-2 leading-relaxed">{item.text}</p>
                    {item.entities && (
                      <div className="flex gap-1 mt-1 flex-wrap">
                        {(typeof item.entities === "string" ? item.entities.split(", ") : item.entities)
                          .slice(0, 3)
                          .map((entity: string, _i: number) => (
                            <span
                              key={entity}
                              className="text-3xs px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-medium"
                            >
                              {entity}
                            </span>
                          ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
