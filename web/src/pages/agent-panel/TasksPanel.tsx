import { Link } from "@tanstack/react-router";
import { useRequest } from "ahooks";
import { CheckCircle2, Clock, Play, Settings2, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ExecutionLogInfo, TaskV2Info } from "@/src/api/tasks-v2";
import { taskV2Api } from "@/src/api/tasks-v2";
import { NS } from "@/src/i18n";
import { cn } from "@/src/lib/utils";
import { describeCron } from "./components/CronEditor";

interface TasksPanelProps {
  agentId: string | null;
}

/** 相对时间格式化：Unix 秒级时间戳 */
function formatRelativeTime(
  ts: number | null | undefined,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (ts == null) return "";
  const now = Date.now();
  const diff = now - ts * 1000;
  if (diff < 60_000) return t("relativeTime.justNow");
  if (diff < 3_600_000) return t("relativeTime.minutesAgo", { count: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t("relativeTime.hoursAgo", { count: Math.floor(diff / 3_600_000) });
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** createdAt 为 Unix 秒级时间戳 */
function formatTime(timestamp: number): string {
  const d = new Date(timestamp * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 耗时格式化 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function TasksPanel({ agentId }: TasksPanelProps) {
  const { t } = useTranslation(NS.COMPONENTS);
  const taskT = useTranslation(NS.TASKS_V2).t;

  const [selectedTask, setSelectedTask] = useState<{ id: string; name: string } | null>(null);
  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set());

  // ── 任务列表 ──
  const { data, loading, error, refresh } = useRequest(() => taskV2Api.list({ agentId: agentId!, pageSize: 50 }), {
    ready: !!agentId,
    onError: () => {
      toast.error(t("panelMode.tasksLoadFailed"));
    },
  });

  const tasks: TaskV2Info[] = data?.success !== false ? (data?.data?.items ?? []) : [];

  // 列表加载后默认选中第一条
  useEffect(() => {
    if (!selectedTask && tasks.length > 0) {
      setSelectedTask({ id: tasks[0].id, name: tasks[0].name });
    }
  }, [tasks, selectedTask]);

  // ── 手动触发 ──
  const [triggeringIds, setTriggeringIds] = useState<Set<string>>(new Set());

  const handleTrigger = async (taskId: string) => {
    setTriggeringIds((prev) => new Set(prev).add(taskId));
    try {
      await taskV2Api.trigger(taskId);
      refresh();
    } catch {
      toast.error(t("panelMode.tasksTriggerFailed") ?? "Trigger failed");
    } finally {
      setTriggeringIds((prev) => {
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
    }
  };

  const handleToggle = async (taskId: string) => {
    setTogglingIds((prev) => new Set(prev).add(taskId));
    try {
      await taskV2Api.toggle(taskId);
      refresh();
    } catch {
      toast.error(t("panelMode.tasksToggleFailed"));
    } finally {
      setTogglingIds((prev) => {
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
    }
  };

  const handleSelectTask = (task: TaskV2Info) => {
    setSelectedTask({ id: task.id, name: task.name });
  };

  // 任务切换时：如果新选中任务之前已选则取消（toggle），否则选中
  const handleTaskClick = (task: TaskV2Info) => {
    if (selectedTask?.id === task.id) {
      setSelectedTask(null);
    } else {
      handleSelectTask(task);
    }
  };

  /** 最后执行状态展示 */
  const renderLastRun = (task: TaskV2Info) => {
    const relTime = formatRelativeTime(task.lastRunAt, taskT);
    if (!task.lastStatus) {
      return relTime ? <span className="text-[11px] text-text-muted">{relTime}</span> : null;
    }
    const Icon =
      task.lastStatus === "success"
        ? CheckCircle2
        : task.lastStatus === "failed"
          ? XCircle
          : task.lastStatus === "timeout"
            ? Clock
            : null;
    const colorClass =
      task.lastStatus === "success"
        ? "text-emerald-600"
        : task.lastStatus === "failed"
          ? "text-red-500"
          : task.lastStatus === "timeout"
            ? "text-amber-500"
            : "text-text-muted";
    return (
      <span className={`flex items-center gap-1 text-[11px] ${colorClass}`}>
        {Icon && <Icon className="size-3" />}
        {taskT(`status.${task.lastStatus}`)}
        {relTime && ` · ${relTime}`}
      </span>
    );
  };

  return (
    <div className="flex flex-col h-full">
      {/* ── 上半部分：任务列表 ── */}
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-3 py-2 border-b border-border/40 flex-shrink-0">
          <span className="text-xs font-medium text-text-primary">{t("panelMode.tasksListTitle")}</span>
          <Link to="/agent/tasks" className="text-xs text-brand hover:text-brand-hover transition-colors">
            {t("panelMode.tasksManage")}
          </Link>
        </div>
        {error ? (
          <div className="flex-1 flex items-center justify-center py-8 px-4">
            <p className="text-sm text-text-muted">{t("panelMode.tasksLoadFailed")}</p>
          </div>
        ) : loading ? (
          <div className="p-3 space-y-2.5">
            {Array.from({ length: 3 }).map((_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: loading skeleton
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : tasks.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center py-8 px-4 gap-3">
            <p className="text-sm text-text-muted">{t("panelMode.tasksEmpty")}</p>
            <Link
              to="/agent/tasks"
              className="inline-flex items-center gap-1.5 text-xs text-brand hover:text-brand-hover transition-colors"
            >
              <Settings2 className="h-3.5 w-3.5" />
              {t("panelMode.tasksManage")}
            </Link>
          </div>
        ) : (
          <ScrollArea className="flex-1">
            {tasks.map((task) => {
              const cronDesc = describeCron(task.cron, taskT);
              return (
                <div
                  key={task.id}
                  className={cn(
                    "group flex items-center gap-3 px-3 py-2.5 border-b border-border/40 hover:bg-surface-2/50 cursor-pointer transition-colors",
                    selectedTask?.id === task.id && "bg-surface-2",
                    !task.enabled && "opacity-50",
                  )}
                  onClick={() => handleTaskClick(task)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") handleTaskClick(task);
                  }}
                  role="button"
                  tabIndex={0}
                >
                  {/* 左侧：状态圆点 + 名称 + 执行计划 + 上次状态 */}
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <span
                      className={cn("shrink-0 size-2 rounded-full", task.enabled ? "bg-emerald-500" : "bg-slate-400")}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-text-primary truncate">{task.name}</p>
                      <p className="text-xs text-text-muted truncate">{cronDesc ?? task.cron}</p>
                      {renderLastRun(task)}
                    </div>
                  </div>
                  {/* 右侧：hover 时显示 Play，始终显示 Switch */}
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="size-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                      disabled={triggeringIds.has(task.id)}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleTrigger(task.id);
                      }}
                    >
                      <Play className="size-3" />
                    </Button>
                    <Switch
                      checked={task.enabled}
                      onCheckedChange={() => handleToggle(task.id)}
                      disabled={togglingIds.has(task.id)}
                      size="sm"
                      onClick={(e) => e.stopPropagation()}
                    />
                  </div>
                </div>
              );
            })}
          </ScrollArea>
        )}
      </div>

      {/* ── 下半部分：日志区 ── */}
      <div className="flex-1 min-h-0 border-t border-border/40 flex flex-col">
        {selectedTask ? (
          <TaskLogView taskId={selectedTask.id} taskName={selectedTask.name} t={taskT} />
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-xs text-text-muted">选择上方任务查看日志</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── 内联日志查看器 ──

interface TaskLogViewProps {
  taskId: string;
  taskName: string;
  t: (key: string, opts?: Record<string, unknown>) => string;
}

function TaskLogView({ taskId, taskName, t }: TaskLogViewProps) {
  const PAGE_SIZE = 20;
  const [page, setPage] = useState(1);

  const { data, loading, error, run } = useRequest(
    async (p: number) => {
      const { success, data, error } = await taskV2Api.logs(taskId, { page: p, pageSize: PAGE_SIZE });
      if (!success) throw new Error(error?.message ?? "请求失败");
      return data;
    },
    {
      defaultParams: [1],
      refreshDeps: [taskId],
    },
  );

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  // taskId 变化时重置分页
  useEffect(() => {
    setPage(1);
  }, [taskId]);

  return (
    <>
      {/* 日志表头 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/40 flex-shrink-0">
        <span className="text-xs font-medium text-text-primary truncate">{t("log.title", { name: taskName })}</span>
        {data && data.total > 0 && (
          <span className="text-xs text-text-muted flex-shrink-0">{t("log.total", { count: data.total })}</span>
        )}
      </div>

      {/* 日志内容 */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {error ? (
          <p className="text-center text-destructive py-8 text-sm">{error.message}</p>
        ) : loading ? (
          <div className="py-4 px-3 space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : !data?.items?.length ? (
          <p className="text-center text-text-muted py-8 text-sm">{t("log.empty")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">{t("log.time")}</TableHead>
                <TableHead className="text-xs">{t("log.triggeredBy")}</TableHead>
                <TableHead className="text-xs">{t("log.status")}</TableHead>
                <TableHead className="text-xs">{t("log.result")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((log: ExecutionLogInfo) => (
                <TableRow key={log.id}>
                  <TableCell className="text-xs whitespace-nowrap">{formatTime(log.createdAt)}</TableCell>
                  <TableCell>
                    <span className="text-xs text-text-muted">
                      {log.triggeredBy === "cron" ? t("triggeredBy.cron") : t("triggeredBy.manual")}
                    </span>
                  </TableCell>
                  <TableCell>
                    <LogStatusBadge status={log.status} t={t} />
                  </TableCell>
                  <TableCell className="max-w-[150px]">
                    <div className="truncate text-xs">
                      {log.error ? (
                        <span className="text-destructive">{log.error}</span>
                      ) : log.skipReason ? (
                        <span className="text-text-muted">{log.skipReason}</span>
                      ) : (
                        log.resultSummary || t("log.noResult")
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {/* 分页控件 */}
      {data && data.total > 0 && (
        <div className="flex items-center justify-center gap-2 py-2 border-t border-border/40 flex-shrink-0">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => {
              const p = page - 1;
              setPage(p);
              run(p);
            }}
            disabled={page <= 1}
          >
            {t("log.prev")}
          </Button>
          <span className="text-xs text-text-muted">
            {page}/{totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => {
              const p = page + 1;
              setPage(p);
              run(p);
            }}
            disabled={page >= totalPages}
          >
            {t("log.next")}
          </Button>
        </div>
      )}
    </>
  );
}

function LogStatusBadge({ status, t }: { status: string; t: (key: string) => string }) {
  const labelMap = useMemo<Record<string, string>>(
    () => ({
      success: t("status.success"),
      failed: t("status.failed"),
      timeout: t("status.timeout"),
      skipped: t("status.skipped"),
      pending: t("status.pending"),
    }),
    [t],
  );
  const variant: "default" | "destructive" | "secondary" =
    status === "success" ? "default" : status === "failed" || status === "timeout" ? "destructive" : "secondary";
  return (
    <Badge variant={variant} className="text-[11px] h-5">
      {labelMap[status] || labelMap.pending}
    </Badge>
  );
}
