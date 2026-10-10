// pages/list/workflow-run-log-index.tsx
// 「运行日志」弹窗的**左栏**：执行记录索引 + 平台触发的运行（底部分组）。
//
// 为什么单独成文件：左栏是**索引**（谁跑过、什么时候、结果如何），右栏（`workflow-run-log-detail.tsx`）是
// **详情**（这一次的输入输出）。两栏的数据密度、选中语义和滚动行为都不同，拆开后各自的滚动边界与「容器不随
// 取数重建」这类约束就有明确归属，也不用把弹窗外壳撑到几百行。
//
// 选中态由外层持有（键的语义见 `resolveRunSelection`），本文件只保证「可选中 / 不可选中」渲染对：缺执行 ID
// 或缺上游 ID 的记录**不是可操作项**——详情按两者取数、缺一取不到，做成禁用按钮只会诱使用户反复点。
//
// 窄列里的信息密度是有取舍的：执行 ID 是主标识（超长截断，全文由 `title` 与右栏头部的完整 ID 兜住），随行
// 只带状态徽标、模式、开始时间与耗时；节点数与错误码留给右栏详情——那是「这次为什么失败」的入口，窄列塞不下。

import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { StatusBadge } from "@fenix/ui-components/config/StatusBadge";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { Inbox } from "lucide-react";
import { useTranslation } from "react-i18next";
import { WORKFLOW_NS } from "../../i18n/namespace";
import {
  PLATFORM_RUN_RESULT_KEYS,
  RUN_STATUS_TONES,
  runSelectionKey,
  type WorkflowPlatformRunRow,
  type WorkflowRunRecordRow,
  type WorkflowRunSelection,
} from "./workflow-run-log-model";

/** 图标统一尺寸（不写尺寸类时 lucide 用默认 24px，与包内其它状态块不一致）。 */
const ICON_CLASS = "size-6";

/**
 * 左栏条目：两行——执行 ID 一行（窄列放不下完整 ID，截断 + `title` 给全文）、状态与时间一行。
 *
 * 三态配色按 `aria-current` 走（与 `agent-catalog-index` 同款：语义属性驱动样式，不另设选中类名）；悬停态
 * 用同一块底色，窄列里加边框会随选中来回抖动。
 */
const INDEX_ITEM_CLASS =
  "flex w-full flex-col gap-1 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden aria-[current=true]:bg-surface-2";

/** 左栏两条元信息行：模式 / 状态 / 开始时间 / 耗时（节点数与错误码只在右栏，窄列塞不下）。 */
const INDEX_ITEM_META_CLASS = "flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-text-muted";

/** 左栏一条执行记录：执行 ID 是主标识，状态徽标、模式、时间、耗时随行。 */
function RunIndexItem({
  row,
  selected,
  onSelect,
}: {
  readonly row: WorkflowRunRecordRow;
  readonly selected: boolean;
  readonly onSelect: (key: string) => void;
}) {
  const { t } = useTranslation(WORKFLOW_NS);
  const unknown = t("run.value_unknown");

  const body = (
    <>
      <span className="min-w-0 truncate text-sm font-medium" title={row.executeId ?? undefined}>
        {t("run.record_execute_id", { id: row.executeId ?? unknown })}
      </span>
      <span className={INDEX_ITEM_META_CLASS}>
        <StatusBadge status={row.statusKey} label={t(row.statusKey)} tone={RUN_STATUS_TONES[row.statusKey]} />
        <span>{t(row.modeKey)}</span>
        <span>{t("run.record_started_at", { time: row.startedAt ?? unknown })}</span>
        <span>{t("run.record_duration", { duration: row.duration ?? unknown })}</span>
      </span>
    </>
  );

  if (row.io === null) {
    return (
      <li
        className="flex cursor-default flex-col gap-1 rounded-md px-2 py-1.5 opacity-70"
        title={t("run.detail_unavailable")}
      >
        {body}
      </li>
    );
  }

  return (
    <li>
      <button
        type="button"
        className={INDEX_ITEM_CLASS}
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(runSelectionKey(row))}
      >
        {body}
      </button>
    </li>
  );
}

/** 左栏底部的平台侧记录分组：条目可选中，右栏展示其已有字段并说明没有输入输出。 */
function PlatformRunIndexItem({
  row,
  selected,
  onSelect,
}: {
  readonly row: WorkflowPlatformRunRow;
  readonly selected: boolean;
  readonly onSelect: (key: string) => void;
}) {
  const { t } = useTranslation(WORKFLOW_NS);
  // 认不出的结果如实展示原文：不把它翻译成一句看似精确的结论（与右栏同口径）。
  const resultKey = PLATFORM_RUN_RESULT_KEYS[row.result];

  return (
    <li>
      <button
        type="button"
        className={INDEX_ITEM_CLASS}
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(row.key)}
      >
        <span className={INDEX_ITEM_META_CLASS}>
          <span>{t("run.platform_time", { time: row.time ?? t("run.value_unknown") })}</span>
          <span>{t("run.platform_result", { result: resultKey ? t(resultKey) : row.result })}</span>
        </span>
      </button>
    </li>
  );
}

/**
 * 左栏「记录区」骨架：取数期间顶住行高（分组标题留在原位）。
 *
 * 与整个左栏容器分开是刻意的：容器（滚动边界）不重建，滚动位置因此不在取数时跳回顶部；只有这块内容在
 * 「骨架 ↔ 行」之间切换。`aria-busy` 是本包「区域正在取数」的统一判据。
 */
function RunIndexSkeleton() {
  const { t } = useTranslation(WORKFLOW_NS);

  return (
    <div aria-busy="true" aria-label={t("run.loading")} className="flex flex-col gap-1" role="status">
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-12 w-full" />
    </div>
  );
}

/** 左栏：执行记录在上、平台触发的运行在底部分组；选中态与点击由外层持有。 */
export function RunIndex({
  rows,
  platformRows,
  selection,
  loading,
  onSelect,
}: {
  readonly rows: readonly WorkflowRunRecordRow[];
  readonly platformRows: readonly WorkflowPlatformRunRow[];
  readonly selection: WorkflowRunSelection;
  readonly loading: boolean;
  readonly onSelect: (key: string) => void;
}) {
  const { t } = useTranslation(WORKFLOW_NS);

  return (
    // 窄屏单列时限高 `max-h-64`（弹窗外框高度固定、内容自己滚），`md` 起固定 `w-60`（15rem，与主从壳的索引
    // 列同尺）并占满外框高度。这里是左栏唯一的滚动边界，容器**不随取数重建**（见文件头）。
    // `[scrollbar-gutter:stable]` 预留滚动条槽：列表长短变化时内容宽度不跟着变（同款用法见
    // `ui-components` 的 chat-status-panel）。
    <div
      data-slot="run-index-scroll"
      className="flex max-h-64 min-h-0 shrink-0 flex-col gap-4 overflow-y-auto border-b border-border-subtle bg-surface-1 px-2 py-3 [scrollbar-gutter:stable] md:max-h-none md:w-60 md:shrink-0 md:border-r md:border-b-0"
    >
      <section className="flex flex-col gap-1">
        <h3 className="px-1 text-xs font-medium text-text-muted">{t("run.records_title")}</h3>
        {loading ? (
          <RunIndexSkeleton />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Inbox className={ICON_CLASS} />}
            title={t("run.empty_title")}
            description={t("run.empty_hint")}
            tone="neutral"
            className="py-6"
          />
        ) : (
          <ul className="flex flex-col gap-1">
            {rows.map((row) => (
              <RunIndexItem
                key={row.key}
                row={row}
                selected={selection.key !== null && selection.key === runSelectionKey(row)}
                onSelect={onSelect}
              />
            ))}
          </ul>
        )}
      </section>

      {/*
        平台侧运行记录：上游 2026-10-09 起有「列出执行历史」的读出口（上面的运行清单就来自它），但那只覆盖
        **上游侧**的执行；平台自己触发的运行（对外接口）在本地审计流水里另有留痕——这一段回答「平台这边跑过
        几次、结果如何」。与上游清单分开展示：两者粒度不同（时间+结果 vs 上游 span 的 logId/耗时），合并会把
        两件事说成一件。为空（或这批数据还没到）时不渲染整段，不给用户看一个恒空的标题，也不上屏上一批的留痕。
      */}
      {loading || platformRows.length === 0 ? null : (
        <section className="flex flex-col gap-1">
          <h3 className="px-1 text-xs font-medium text-text-muted">{t("run.platform_title")}</h3>
          <ul className="flex flex-col gap-1">
            {platformRows.map((row) => (
              <PlatformRunIndexItem key={row.key} row={row} selected={selection.key === row.key} onSelect={onSelect} />
            ))}
          </ul>
          <p className="px-1 text-xs text-text-dim">{t("run.platform_hint")}</p>
        </section>
      )}
    </div>
  );
}
