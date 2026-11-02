import { Ban, CheckCircle2, Clock3, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import { cn } from "../../lib/cn";
import type { PeriTaskViewProjection } from "../types";

/**
 * 折叠阈值：任务数超出即出现「更多 agent」入口，展开后显示全部并可收起。
 * 用户反馈列表一次铺满会挤压输入区，故默认只显示前 N 条。
 */
export const PERI_TASK_COLLAPSE_THRESHOLD = 5;

/** 非法时间不推测耗时；终态缺少结束时间时也不继续计时。 */
export function taskElapsedSeconds(task: PeriTaskViewProjection, now: number): number | null {
  const start = Date.parse(task.startedAt);
  const end = task.status === "running" ? now : Date.parse(task.completedAt ?? "");
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.floor((end - start) / 1000)) : null;
}

/**
 * 「子任务」区（`ChatStatusPanel` 的 tasks 页签）唯一的任务行列表实现：状态、运行高亮、
 * 失败原因（投影里的脱敏摘要）、按 `startedAt`/`completedAt` 计算的耗时；运行中每秒刷新计时，
 * 终态停止。状态只由任务自身终态事件或 turn 取消/中断收敛决定，不对正常完成做推断。
 *
 * 行内为**单行**排布：名称、状态、耗时同一行；失败原因不丢，改为单行截断并以 `title` 承载全文
 * （用户反馈：右侧状态与耗时堆两行会抬高每行高度、挤压输入区）。耗时用 `tabular-nums`，
 * 避免每秒刷新时宽度抖动。
 *
 * 列表超过 `PERI_TASK_COLLAPSE_THRESHOLD` 时折叠为前 N 条 + 「更多 agent」入口（展开后显示全部）。
 * 点击行由调用方接详情（宿主注入的 `renderPeriTaskDetail` → `PeriTaskDetailSheet`），本组件不自建详情。
 */
export function PeriTaskRows({
  tasks,
  loaded,
  reconnecting = false,
  onOpenTask,
}: {
  tasks: readonly PeriTaskViewProjection[];
  loaded: boolean;
  reconnecting?: boolean;
  onOpenTask?: (task: PeriTaskViewProjection) => void;
}) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const [now, setNow] = useState(Date.now);
  const [expanded, setExpanded] = useState(false);
  const running = tasks.some((task) => task.status === "running");
  useEffect(() => {
    if (!running || !loaded) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, loaded]);

  if (!loaded)
    return (
      <p role="status" className="p-3 text-xs text-muted-foreground">
        {t("chat.components.periTask.loading")}
      </p>
    );

  const collapsible = tasks.length > PERI_TASK_COLLAPSE_THRESHOLD;
  const visible = collapsible && !expanded ? tasks.slice(0, PERI_TASK_COLLAPSE_THRESHOLD) : tasks;
  const hiddenCount = tasks.length - visible.length;

  return (
    <div className="grid gap-1 p-2">
      {reconnecting && (
        <p role="status" className="px-1 text-xs text-amber-700">
          {t("chat.components.periTask.reconnecting")}
        </p>
      )}
      {tasks.length === 0 && <p className="p-1 text-xs text-muted-foreground">{t("chat.components.periTask.empty")}</p>}
      {visible.map((task) => {
        const Icon =
          task.status === "completed"
            ? CheckCircle2
            : task.status === "failed"
              ? XCircle
              : task.status === "cancelled"
                ? Ban
                : Clock3;
        const elapsed = taskElapsedSeconds(task, now);
        const failureReason = task.summary ?? t("chat.components.periTask.failureUnavailable");
        return (
          <button
            key={task.taskId}
            type="button"
            data-status={task.status}
            disabled={!onOpenTask}
            onClick={() => onOpenTask?.(task)}
            className={cn(
              "flex min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default",
              task.status === "running" ? "bg-sky-50 text-sky-800" : "text-slate-600 enabled:hover:bg-slate-50",
            )}
          >
            <Icon
              aria-hidden="true"
              className={cn(
                "size-4 shrink-0",
                task.status === "failed"
                  ? "text-red-400"
                  : task.status === "completed"
                    ? "text-teal-600"
                    : "text-current",
              )}
            />
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              <span className="min-w-0 truncate" title={task.title}>
                {task.title ?? t("chat.components.periTask.unknownTitle")}
              </span>
              {task.status === "failed" && (
                <span className="min-w-0 truncate text-red-600" title={failureReason}>
                  {failureReason}
                </span>
              )}
            </span>
            <span className="shrink-0">{t(`chat.components.periTask.status.${task.status}`)}</span>
            <span className="shrink-0 text-muted-foreground tabular-nums">
              {elapsed === null
                ? t("chat.components.periTask.timeUnavailable")
                : t("chat.components.periTask.elapsed", { minutes: Math.floor(elapsed / 60), seconds: elapsed % 60 })}
            </span>
          </button>
        );
      })}
      {collapsible && (
        <button
          type="button"
          className="flex min-h-7 items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs text-sky-700 enabled:hover:bg-slate-50"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? (
            t("chat.components.periTask.showLess")
          ) : (
            <>
              {t("chat.components.periTask.moreAgents")}
              <small className="text-3xs text-gray-400">{hiddenCount}</small>
            </>
          )}
        </button>
      )}
    </div>
  );
}
