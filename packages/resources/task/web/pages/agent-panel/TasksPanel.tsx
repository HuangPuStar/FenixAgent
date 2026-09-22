import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { StatusBadge } from "@fenix/ui-components/config/StatusBadge";
import { cn } from "@fenix/ui-components/lib/cn";
import { Button } from "@fenix/ui-components/ui/button";
import { ScrollArea } from "@fenix/ui-components/ui/scroll-area";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { Switch } from "@fenix/ui-components/ui/switch";
import { unwrap } from "@fenix/web-runtime/api/request";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { Link } from "@tanstack/react-router";
import { useRequest } from "ahooks";
import { AlertTriangle, CheckCircle2, Clock, Play, Settings2, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { TaskV2Info } from "../../api/tasks-v2";
import { taskV2Api } from "../../api/tasks-v2";
import { describeCron } from "./components/CronEditor";
import { ExecutionLogTable } from "./components/ExecutionLogTable";
import {
  formatTaskRelativeTime,
  isUnauthorizedError,
  removeIdFromSet,
  TASK_ENABLED_TONES,
} from "./pages/agent-tasks-utils";

interface TasksPanelProps {
  agentId: string | null;
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
      // 必须解包：`request()` 对 4xx/5xx 返回 `{ success: false }` 而不 throw，直接 await 会把失败当成功，
      // catch 永远不可达，用户既看不到失败提示、也会基于未变更的状态刷新。
      await unwrap(taskV2Api.trigger(taskId));
      refresh();
    } catch {
      toast.error(taskT("panelMode.tasksTriggerFailed") ?? "Trigger failed");
    } finally {
      setTriggeringIds((prev) => removeIdFromSet(prev, taskId));
    }
  };

  const handleToggle = async (taskId: string) => {
    setTogglingIds((prev) => new Set(prev).add(taskId));
    try {
      // 同 handleTrigger：不解包则失败被当成成功，状态未变却刷新列表、也不提示。
      await unwrap(taskV2Api.toggle(taskId));
      refresh();
    } catch {
      toast.error(taskT("panelMode.tasksToggleFailed"));
    } finally {
      setTogglingIds((prev) => removeIdFromSet(prev, taskId));
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
    const relTime = formatTaskRelativeTime(task.lastRunAt, taskT, { fallback: "", dateFormat: "compact" });
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
          <EmptyState
            icon={<AlertTriangle className="size-6" />}
            title={unauthorized ? taskT("loadState.unauthorizedTitle") : taskT("panelMode.tasksLoadFailed")}
            description={unauthorized ? taskT("loadState.unauthorizedHint") : undefined}
            tone="danger"
            role="alert"
            action={unauthorized ? undefined : { label: taskT("loadState.retry"), onClick: refresh, disabled: loading }}
            className="flex-1 flex flex-col items-center justify-center py-8 px-4"
          />
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
                    {/* 状态不再手写色值：色调走 `TASK_ENABLED_TONES`，点在组件库内用 `bg-current`
                        取当前文字色，本包只管「启用算好消息、停用算中性」。文案不传，由 StatusBadge
                        查自己的 `statusBadge.enabled` / `disabled`（本包不新增同义 i18n key）。 */}
                    <StatusBadge
                      status={task.enabled ? "enabled" : "disabled"}
                      toneMap={TASK_ENABLED_TONES}
                      indicator="dot"
                      className="shrink-0 h-5 px-1.5"
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
          <>
            {/* 头部留在面板侧（弹窗侧同理，只保留自己的头部差异）；取数、表格、分页与三态由
                `ExecutionLogTable` 统一承担。条数随之只出现一次（分页栏），表头不再重复展示。
                `key` 保证换任务时回到第 1 页，而不是沿用上一个任务的页码。 */}
            <div className="flex items-center px-3 py-2 border-b border-border/40 flex-shrink-0">
              <span className="text-xs font-medium text-text-primary truncate">
                {taskT("log.title", { name: selectedTask.name })}
              </span>
            </div>
            <ExecutionLogTable key={selectedTask.id} taskId={selectedTask.id} />
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-xs text-text-muted">选择上方任务查看日志</p>
          </div>
        )}
      </div>
    </div>
  );
}
