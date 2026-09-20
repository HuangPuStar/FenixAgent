import { cn } from "@fenix/ui-components/lib/cn";
import { Badge } from "@fenix/ui-components/ui/badge";
import { Button } from "@fenix/ui-components/ui/button";
import { ScrollArea } from "@fenix/ui-components/ui/scroll-area";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { Switch } from "@fenix/ui-components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@fenix/ui-components/ui/table";
import { unwrap } from "@fenix/web-runtime/api/request";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { Link } from "@tanstack/react-router";
import { useRequest } from "ahooks";
import { AlertTriangle, CheckCircle2, Clock, Play, RefreshCw, Settings2, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { ExecutionLogInfo, TaskV2Info } from "../../api/tasks-v2";
import { taskV2Api } from "../../api/tasks-v2";
import { describeCron } from "./components/CronEditor";
import { isUnauthorizedError } from "./pages/agent-tasks-utils";

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

export function TasksPanel({ agentId }: TasksPanelProps) {
  // 面板文案统一读本包命名空间：`panelMode.tasks*` 曾借宿主 `components` 命名空间（键的最终所在地 = 包的 owner，
  // 计划 §4），现随 `web/i18n/locales/{en,zh}/tasks-v2.json` 自持；宿主同名键由 W3 的宿主 patch 删除。
  const taskT = useTranslation(NS.TASKS_V2).t;

  const [selectedTask, setSelectedTask] = useState<{ id: string; name: string } | null>(null);
  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set());

  // ── 任务列表 ──
  // 必须经 `unwrap` 而不是自己读信封：ahooks 只在 promise reject 时置 `error`，旧写法（读 `data.success`）
  // 在请求失败时把 error 恒留为 undefined，失败被静默降级成空数组，「加载失败」于是显示成「暂无任务」，
  // 也没有任何恢复入口。授权类失败（401/403）另走无权限分支，不给重试。
  const {
    data: pageData,
    loading,
    error,
    refresh,
  } = useRequest(async () => unwrap(taskV2Api.list({ agentId: agentId!, pageSize: 50 })), {
    ready: !!agentId,
    onError: () => {
      toast.error(taskT("panelMode.tasksLoadFailed"));
    },
  });

  const tasks: TaskV2Info[] = pageData?.items ?? [];
  const unauthorized = isUnauthorizedError(error);

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
      toast.error(taskT("panelMode.tasksTriggerFailed") ?? "Trigger failed");
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
      toast.error(taskT("panelMode.tasksToggleFailed"));
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
          <span className="text-xs font-medium text-text-primary">{taskT("panelMode.tasksListTitle")}</span>
          <Link to="/agent/tasks" className="text-xs text-brand hover:text-brand-hover transition-colors">
            {taskT("panelMode.tasksManage")}
          </Link>
        </div>
        {error ? (
          // 持久错误分支（`role="alert"`）：失败不能落进下面的「暂无任务」空态，否则用户分不清
          // 「加载失败」与「确实没有绑定任务」；非授权失败必须给重试入口，授权失败只说明原因。
          <div className="flex-1 flex flex-col items-center justify-center gap-3 py-8 px-4 text-center" role="alert">
            <AlertTriangle className="h-6 w-6 text-text-dim" />
            <p className="text-sm text-text-muted">
              {unauthorized ? taskT("loadState.unauthorizedTitle") : taskT("panelMode.tasksLoadFailed")}
            </p>
            {unauthorized ? (
              <p className="text-xs text-text-muted">{taskT("loadState.unauthorizedHint")}</p>
            ) : (
              <Button size="sm" variant="outline" onClick={refresh} disabled={loading}>
                <RefreshCw className="mr-1 h-3.5 w-3.5" />
                {taskT("loadState.retry")}
              </Button>
            )}
          </div>
        ) : loading ? (
          <div className="p-3 space-y-2.5" aria-busy="true">
            {Array.from({ length: 3 }).map((_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 骨架屏是静态装饰、不重排，索引键不会引起元素错位；包内按 T2e 声明 react 后本规则才启用。
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : tasks.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center py-8 px-4 gap-3">
            <p className="text-sm text-text-muted">{taskT("panelMode.tasksEmpty")}</p>
            <Link
              to="/agent/tasks"
              className="inline-flex items-center gap-1.5 text-xs text-brand hover:text-brand-hover transition-colors"
            >
              <Settings2 className="h-3.5 w-3.5" />
              {taskT("panelMode.tasksManage")}
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
                    "group flex items-center gap-3 px-3 py-2.5 border-b border-border/40 hover:bg-surface-2/50 transition-colors",
                    selectedTask?.id === task.id && "bg-surface-2",
                    !task.enabled && "opacity-50",
                  )}
                >
                  {/* 左侧选择区落到真正的 button 上：容器不再伪造 role="button" 去包住右侧的 Button/Switch，
                      嵌套交互控件会让读屏与键盘落到哪个控件产生歧义，也违反「按钮里不放按钮」。
                      代价是点击热区收敛到这一块（其余位置是行内留白，不再触发选中）。 */}
                  <button
                    type="button"
                    className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer text-left"
                    aria-pressed={selectedTask?.id === task.id}
                    onClick={() => handleTaskClick(task)}
                  >
                    <span
                      className={cn("shrink-0 size-2 rounded-full", task.enabled ? "bg-emerald-500" : "bg-slate-400")}
                    />
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-medium text-text-primary truncate">{task.name}</span>
                      <span className="block text-xs text-text-muted truncate">{cronDesc ?? task.cron}</span>
                      {renderLastRun(task)}
                    </span>
                  </button>
                  {/* 右侧：hover 时显示 Play，始终显示 Switch。都是纯图标控件，可访问名只能由 aria-label 提供。 */}
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="size-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                      disabled={triggeringIds.has(task.id)}
                      aria-label={taskT("action.execute")}
                      onClick={() => handleTrigger(task.id)}
                    >
                      <Play className="size-3" />
                    </Button>
                    <Switch
                      checked={task.enabled}
                      onCheckedChange={() => handleToggle(task.id)}
                      disabled={togglingIds.has(task.id)}
                      size="sm"
                      aria-label={task.enabled ? taskT("card.disabled") : taskT("card.enabled")}
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
          <TaskLogView key={selectedTask.id} taskId={selectedTask.id} taskName={selectedTask.name} t={taskT} />
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

  // 与任务列表同理：经 `unwrap` 抛出 ApiError，失败才带得出错误码（无权限分支据此判定），
  // 自造 `new Error(...)` 会把 401/403 与普通故障混成同一类，页面只能一律给重试。
  const { data, loading, error, run } = useRequest(
    async (p: number) => unwrap(taskV2Api.logs(taskId, { page: p, pageSize: PAGE_SIZE })),
    {
      defaultParams: [1],
      refreshDeps: [taskId],
    },
  );

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  // 与列表侧同口径：401/403 是持久授权状态，只说明原因（标题 + 提示）且不给重试；其余失败给一次重试。
  const unauthorized = isUnauthorizedError(error);

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
          // 权限态与瞬时故障分开：401/403 只说明原因，其余失败给一次重试（沿用分页按钮的 run(page) 入口）。
          <div className="flex flex-col items-center gap-2 py-8 px-3 text-center" role="alert">
            <p className="text-sm text-destructive">
              {unauthorized ? t("loadState.unauthorizedTitle") : t("loadState.failed", { message: error.message })}
            </p>
            {unauthorized ? (
              <p className="text-xs text-text-muted">{t("loadState.unauthorizedHint")}</p>
            ) : (
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => run(page)}>
                {t("loadState.retry")}
              </Button>
            )}
          </div>
        ) : loading ? (
          <div className="py-4 px-3 space-y-2" aria-busy="true">
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
