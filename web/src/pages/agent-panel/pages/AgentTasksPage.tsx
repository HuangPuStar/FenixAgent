import { useRequest } from "ahooks";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { FormDialog } from "@/components/config/FormDialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { envApi } from "@/src/api/environments";
import { fileApi } from "@/src/api/files";
import { unwrap } from "@/src/api/request";
import { taskApi } from "@/src/api/tasks";
import { AgentCardList } from "../shared/AgentCardList";
import { AgentPageHeader } from "../shared/AgentPageHeader";

interface TaskItem {
  id: string;
  name: string;
  description?: string;
  cron: string;
  environmentId: string;
  environmentName?: string;
  task: string;
  timeoutMinutes: number;
  enabled: boolean;
  lastRunAt?: number;
  nextRunAt?: number;
  lastStatus?: string | null;
}

interface ExecutionLogItem {
  id: string;
  status: string;
  triggeredBy: string;
  duration?: number | null;
  createdAt: number;
  workspacePath?: string | null;
  workspaceName?: string | null;
  resultSummary?: string | null;
  skipReason?: string | null;
  error?: string | null;
  environmentId?: string | null;
}

interface FileInfo {
  name: string;
  path: string;
  type: "file" | "dir";
  size: number;
  modifiedAt: number;
}

interface EnvInfo {
  id: string;
  name: string;
  workspacePath?: string;
  sessionId?: string;
}

const CRON_PRESETS_KEYS = [
  { labelKey: "cronPresets.every5min", value: "*/5 * * * *" },
  { labelKey: "cronPresets.hourly", value: "0 * * * *" },
  { labelKey: "cronPresets.daily9am", value: "0 9 * * *" },
  { labelKey: "cronPresets.weekday9am", value: "0 9 * * 1-5" },
  { labelKey: "cronPresets.monthly1st", value: "0 0 1 * *" },
];

function validateTaskForm(
  t: (key: string, options?: Record<string, unknown>) => string,
  name: string,
  environmentId: string,
  task: string,
  cron: string,
  timeoutMinutes: string,
): string | null {
  if (!name.trim()) return t("validation.nameRequired");
  if (!environmentId) return t("validation.environmentRequired");
  if (!task.trim()) return t("validation.taskRequired");
  if (!cron.trim()) return t("validation.cronRequired");
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return t("validation.cronFormat");
  const timeoutValue = Number(timeoutMinutes);
  if (!Number.isInteger(timeoutValue) || timeoutValue < 1 || timeoutValue > 180) return t("validation.timeoutRange");
  return null;
}

function formatTimestamp(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatLastResult(t: (key: string, options?: Record<string, unknown>) => string, task: TaskItem): string {
  if (!task.lastStatus) return "—";
  if (task.lastStatus === "skipped") return t("lastResult.skipped");
  if (task.lastStatus === "timeout") return t("lastResult.timeout");
  if (task.lastStatus === "failed") return t("lastResult.failed");
  return t("lastResult.success");
}

function statusColor(status: string | null | undefined): string {
  if (!status) return "bg-surface-2 text-text-muted";
  if (status === "success") return "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400";
  if (status === "failed" || status === "timeout")
    return "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400";
  if (status === "skipped") return "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400";
  return "bg-surface-2 text-text-muted";
}

function toWorkspaceRelativePath(environment: EnvInfo, workspacePath: string): string {
  const prefix = (environment.workspacePath ?? "").replace(/\/$/, "");
  if (!workspacePath.startsWith(prefix)) return workspacePath.replace(/^\//, "");
  return workspacePath.slice(prefix.length).replace(/^\/+/, "");
}

export function AgentTasksPage() {
  const { t } = useTranslation("tasks");

  // ── 列表查询：合并 task 列表 + environment 列表 ──
  const {
    data: listData,
    loading,
    refresh,
  } = useRequest(
    async () => {
      const [taskData, envData] = await Promise.all([unwrap(taskApi.list()), unwrap(envApi.list())]);
      return { tasks: taskData, environments: envData };
    },
    {
      onError: (err: Error) => {
        console.error(t("toast.loadPageFailed", { error: "" }), err);
        toast.error(t("toast.loadPageFailed", { error: err.message }));
      },
    },
  );
  const tasks: TaskItem[] = Array.isArray(listData?.tasks) ? (listData.tasks as unknown as TaskItem[]) : [];
  const environments: EnvInfo[] = Array.isArray(listData?.environments)
    ? (listData.environments as unknown as EnvInfo[])
    : [];

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<TaskItem | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<TaskItem | null>(null);

  const [logsTask, setLogsTask] = useState<TaskItem | null>(null);
  const [logsDialogOpen, setLogsDialogOpen] = useState(false);
  const [logsPage, setLogsPage] = useState(1);
  const [clearLogsConfirmOpen, setClearLogsConfirmOpen] = useState(false);
  const [workspaceEntries, setWorkspaceEntries] = useState<FileInfo[]>([]);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workspaceTitle, setWorkspaceTitle] = useState<string | null>(null);

  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formCron, setFormCron] = useState("*/5 * * * *");
  const [formEnvironmentId, setFormEnvironmentId] = useState("");
  const [formTask, setFormTask] = useState("");
  const [formTimeoutMinutes, setFormTimeoutMinutes] = useState("30");
  const [formEnabled, setFormEnabled] = useState(true);
  const [triggeringTaskId, setTriggeringTaskId] = useState<string | null>(null);

  // ── 分页加载执行日志 ──
  const {
    data: logsData,
    loading: logsLoading,
    run: runLoadLogs,
  } = useRequest((taskId: string, page: number) => unwrap(taskApi.logs(taskId, { page, pageSize: 20 })), {
    manual: true,
  });
  const logs: ExecutionLogItem[] = Array.isArray(logsData?.items)
    ? (logsData.items as unknown as ExecutionLogItem[])
    : [];
  const logsTotal = logsData?.total ?? 0;
  const totalLogPages = Math.max(1, Math.ceil(logsTotal / 20));

  const loadLogs = (taskId: string, page = 1) => {
    setLogsPage(page);
    runLoadLogs(taskId, page);
  };

  // ── 保存（创建/更新）：仅创建时 toast ──
  const { run: runSave, loading: saving } = useRequest(
    async (editId: string | null, payload: Record<string, unknown>) => {
      if (editId) {
        return unwrap(taskApi.update(editId, payload));
      }
      return unwrap(taskApi.create(payload as { name: string; cron: string; url: string }));
    },
    {
      manual: true,
      onSuccess: (_data, [editId]) => {
        if (!editId) toast.success(t("toast.taskCreated"));
        setDialogOpen(false);
        refresh();
      },
      onError: (err: Error) => {
        console.error(t("toast.saveFailed", { error: "" }), err);
        toast.error(t("toast.saveFailed", { error: err.message }));
      },
    },
  );

  // ── 启停切换：静默操作 ──
  const { run: runToggle } = useRequest((id: string) => unwrap(taskApi.toggle(id)), {
    manual: true,
    onSuccess: () => refresh(),
    onError: (err: Error) => {
      console.error(t("toast.toggleFailed", { error: "" }), err);
      toast.error(t("toast.toggleFailed", { error: err.message }));
    },
  });

  // ── 手动触发：展示详细结果 ──
  const { run: runTrigger } = useRequest(
    async (id: string) => {
      setTriggeringTaskId(id);
      return unwrap(taskApi.trigger(id));
    },
    {
      manual: true,
      onSuccess: (result) => {
        toast.success(
          t("toast.triggerSuccess", {
            status: (result as { status?: string } | null)?.status ?? t("misc.unknown"),
            duration: formatDuration((result as { duration?: number | null } | null)?.duration ?? null),
            directory: (result as { workspaceName?: string } | null)?.workspaceName ?? "—",
          }),
        );
        refresh();
      },
      onError: (err: Error) => {
        console.error(t("toast.triggerFailed", { error: "" }), err);
        toast.error(t("toast.triggerFailed", { error: err.message }));
      },
      onFinally: () => {
        setTriggeringTaskId(null);
      },
    },
  );

  // ── 删除：静默操作 ──
  const { run: runDelete } = useRequest((id: string) => unwrap(taskApi.del(id)), {
    manual: true,
    onSuccess: () => {
      setConfirmOpen(false);
      setDeleteTarget(null);
      refresh();
    },
    onError: (err: Error) => {
      console.error(t("toast.deleteFailed", { error: "" }), err);
      toast.error(t("toast.deleteFailed", { error: err.message }));
    },
  });

  // ── 清空日志 ──
  const { run: runClearLogs } = useRequest((id: string) => unwrap(taskApi.clearLogs(id)), {
    manual: true,
    onSuccess: (_data, [id]) => {
      toast.success(t("toast.logsCleared"));
      setClearLogsConfirmOpen(false);
      loadLogs(id, 1);
    },
    onError: (err: Error) => {
      console.error(t("toast.clearLogsFailed", { error: "" }), err);
      toast.error(t("toast.clearLogsFailed", { error: err.message }));
    },
  });

  const resetForm = () => {
    setFormName("");
    setFormDescription("");
    setFormCron("*/5 * * * *");
    setFormEnvironmentId(environments[0]?.id ?? "");
    setFormTask("");
    setFormTimeoutMinutes("30");
    setFormEnabled(true);
  };

  const handleOpenCreate = () => {
    setEditingTask(null);
    resetForm();
    setDialogOpen(true);
  };

  const handleOpenEdit = (task: TaskItem) => {
    setEditingTask(task);
    setFormName(task.name);
    setFormDescription(task.description ?? "");
    setFormCron(task.cron);
    setFormEnvironmentId(task.environmentId);
    setFormTask(task.task);
    setFormTimeoutMinutes(String(task.timeoutMinutes));
    setFormEnabled(task.enabled);
    setDialogOpen(true);
  };

  const handleSave = () => {
    const error = validateTaskForm(t, formName, formEnvironmentId, formTask, formCron, formTimeoutMinutes);
    if (error) {
      toast.error(error);
      return;
    }
    const payload = {
      name: formName.trim(),
      description: formDescription.trim() || undefined,
      cron: formCron.trim(),
      environmentId: formEnvironmentId,
      task: formTask.trim(),
      timeoutMinutes: Number(formTimeoutMinutes),
      enabled: formEnabled,
    };
    runSave(editingTask?.id ?? null, payload);
  };

  const handleViewLogs = (task: TaskItem) => {
    setLogsTask(task);
    setLogsDialogOpen(true);
    setWorkspaceEntries([]);
    setWorkspaceTitle(null);
    loadLogs(task.id, 1);
  };

  const handleBrowseWorkspace = async (log: ExecutionLogItem) => {
    if (!log.workspacePath || !log.environmentId) {
      toast.error(t("toast.noWorkspacePath"));
      return;
    }
    const environment = environments.find((item) => item.id === log.environmentId);
    if (!environment?.sessionId) {
      toast.error(t("toast.noEnvSession"));
      return;
    }
    setWorkspaceLoading(true);
    try {
      const relativePath = toWorkspaceRelativePath(environment, log.workspacePath);
      const wsResult = await unwrap(fileApi.listDir(environment.sessionId!, relativePath));
      setWorkspaceEntries(Array.isArray(wsResult?.entries) ? (wsResult.entries as unknown as FileInfo[]) : []);
      setWorkspaceTitle(relativePath);
    } catch (error) {
      console.error(t("toast.viewDirFailed", { error: "" }), error);
      toast.error(t("toast.viewDirFailed", { error: error instanceof Error ? error.message : t("misc.unknown") }));
    } finally {
      setWorkspaceLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-full overflow-auto bg-[#f4f7fb] px-8 py-7 text-[#14213d]">
        <div className="mb-3 flex items-start justify-between gap-4">
          <div>
            <Skeleton className="h-[22px] w-28 rounded-md" />
            <Skeleton className="mt-1.5 h-3 w-56 rounded-md" />
          </div>
          <Skeleton className="h-10 w-28 rounded-lg" />
        </div>
        <div className="mb-3.5 h-px bg-[#e8edf4]" />
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
            <Skeleton key={i} className="h-20 w-full rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full overflow-auto bg-[#f4f7fb] px-8 py-7 text-[#14213d]">
      <AgentPageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={<Button onClick={handleOpenCreate}>{t("newTask")}</Button>}
      />
      <AgentCardList
        items={tasks}
        cardKey={(task) => task.id}
        searchPlaceholder={t("searchPlaceholder")}
        searchFn={(task, q) =>
          task.name.toLowerCase().includes(q) || (task.environmentName ?? "").toLowerCase().includes(q)
        }
        emptyMessage={t("emptyMessage")}
        renderCard={(task, _isSelected, _toggleSelect) => (
          <div className="group rounded-lg border border-border-light bg-surface-1 px-4 py-3 transition-colors hover:border-border-active hover:shadow-sm">
            <div className="flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-text-bright">{task.name}</span>
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${task.enabled ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" : "bg-surface-2 text-text-muted"}`}
                  >
                    {task.enabled ? t("actions.enable") : t("actions.disable")}
                  </span>
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${statusColor(task.lastStatus)}`}
                  >
                    {formatLastResult(t, task)}
                  </span>
                </div>
                <div className="flex items-center gap-3 mt-1.5 text-xs text-text-muted">
                  <code className="rounded bg-surface-2 px-1.5 py-0.5">{task.cron}</code>
                  <span>{task.environmentName ?? task.environmentId}</span>
                  <span>
                    {t("columns.timeout")}: {task.timeoutMinutes}m
                  </span>
                </div>
                <div className="flex items-center gap-3 mt-1 text-xs text-text-dim">
                  <span>
                    {t("columns.lastRun")}: {formatTimestamp(task.lastRunAt ?? null)}
                  </span>
                  <span>
                    {t("columns.nextRun")}: {formatTimestamp(task.nextRunAt ?? null)}
                  </span>
                </div>
              </div>
              <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={triggeringTaskId === task.id}
                  onClick={() => runTrigger(task.id)}
                >
                  {triggeringTaskId === task.id ? "..." : t("actions.executeNow")}
                </Button>
                <Button size="xs" variant="outline" onClick={() => handleViewLogs(task)}>
                  {t("actions.logs")}
                </Button>
                <Button size="xs" variant="outline" onClick={() => runToggle(task.id)}>
                  {task.enabled ? t("actions.disable") : t("actions.enable")}
                </Button>
                <Button size="xs" variant="outline" onClick={() => handleOpenEdit(task)}>
                  {t("actions.edit")}
                </Button>
                <Button
                  size="xs"
                  variant="destructive"
                  onClick={() => {
                    setDeleteTarget(task);
                    setConfirmOpen(true);
                  }}
                >
                  {t("actions.delete")}
                </Button>
              </div>
            </div>
          </div>
        )}
      />

      <FormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={editingTask ? t("form.editTitle") : t("form.createTitle")}
        onSubmit={handleSave}
        loading={saving}
        width="sm:max-w-2xl"
      >
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="task-name">{t("form.name")}</Label>
            <Input id="task-name" value={formName} onChange={(e) => setFormName(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="task-description">{t("form.description")}</Label>
            <Input id="task-description" value={formDescription} onChange={(e) => setFormDescription(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label>{t("form.cronExpression")}</Label>
            <div className="flex gap-2">
              <Input value={formCron} onChange={(e) => setFormCron(e.target.value)} />
              <Select value={formCron} onValueChange={setFormCron}>
                <SelectTrigger className="w-40">
                  <SelectValue placeholder={t("form.quickSelect")} />
                </SelectTrigger>
                <SelectContent>
                  {CRON_PRESETS_KEYS.map((preset) => (
                    <SelectItem key={preset.value} value={preset.value}>
                      {t(preset.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <p className="text-xs text-text-muted">{t("form.cronHelp")}</p>
          </div>
          <div className="grid gap-2">
            <Label>{t("form.environment")}</Label>
            <Select value={formEnvironmentId} onValueChange={setFormEnvironmentId}>
              <SelectTrigger>
                <SelectValue placeholder={t("form.selectEnvironment")} />
              </SelectTrigger>
              <SelectContent>
                {environments.map((env) => (
                  <SelectItem key={env.id} value={env.id}>
                    {env.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label>{t("form.taskContent")}</Label>
            <Textarea
              value={formTask}
              onChange={(e) => setFormTask(e.target.value)}
              rows={8}
              placeholder={t("form.taskPlaceholder")}
            />
          </div>
          <div className="grid gap-2">
            <Label>{t("form.timeoutMinutes")}</Label>
            <Input
              type="number"
              min={1}
              max={180}
              value={formTimeoutMinutes}
              onChange={(e) => setFormTimeoutMinutes(e.target.value)}
            />
          </div>
          {editingTask && (
            <div className="flex items-center justify-between rounded-md border px-3 py-2">
              <div>
                <p className="text-sm font-medium">{t("form.enabledStatus")}</p>
                <p className="text-xs text-text-muted">{t("form.enabledHint")}</p>
              </div>
              <Switch checked={formEnabled} onCheckedChange={setFormEnabled} />
            </div>
          )}
        </div>
      </FormDialog>

      {/* Execution logs dialog */}
      <Dialog open={logsDialogOpen} onOpenChange={setLogsDialogOpen}>
        <DialogContent className="flex max-h-[90vh] w-[min(96vw,1100px)] flex-col overflow-hidden p-0 sm:max-w-5xl">
          <DialogHeader className="shrink-0 border-b px-6 py-4">
            <DialogTitle>
              {t("logs.title")}
              {logsTask ? ` · ${logsTask.name}` : ""}
            </DialogTitle>
          </DialogHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-4 p-6">
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-text-muted">{t("logs.totalRecords", { count: logsTotal })}</p>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-text-muted">
                  {t("logs.pageInfo", { current: logsPage, total: totalLogPages })}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!logsTask || logsPage <= 1}
                  onClick={() => logsTask && loadLogs(logsTask.id, logsPage - 1)}
                >
                  {t("logs.prevPage")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!logsTask || logs.length < 20}
                  onClick={() => logsTask && loadLogs(logsTask.id, logsPage + 1)}
                >
                  {t("logs.nextPage")}
                </Button>
                <Button size="sm" variant="outline" disabled={!logsTask} onClick={() => setClearLogsConfirmOpen(true)}>
                  {t("logs.clearLogs")}
                </Button>
              </div>
            </div>
            <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(320px,0.9fr)]">
              <div className="flex min-h-0 flex-col rounded-md border">
                <div className="shrink-0 border-b px-4 py-3">
                  <h3 className="font-medium">{t("logs.executionRecords")}</h3>
                  <p className="text-xs text-text-muted">{t("logs.scrollHint")}</p>
                </div>
                <div className="min-h-0 overflow-y-auto p-4">
                  {logsLoading ? (
                    <div className="space-y-2">
                      {Array.from({ length: 3 }).map((_, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
                        <Skeleton key={i} className="h-20 w-full" />
                      ))}
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {logs.map((log) => (
                        <div key={log.id} className="rounded-md border p-4">
                          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <span
                                className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${statusColor(log.status)}`}
                              >
                                {log.status}
                              </span>
                              <span className="text-sm text-text-muted">
                                {formatTimestamp(log.createdAt)} · {log.triggeredBy} ·{" "}
                                {formatDuration(log.duration ?? null)}
                              </span>
                            </div>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={!log.workspacePath || !log.environmentId}
                              onClick={() => handleBrowseWorkspace(log)}
                            >
                              {t("logs.viewDirectory")}
                            </Button>
                          </div>
                          <div className="grid gap-1.5 text-sm">
                            <div>
                              <span className="font-medium text-text-muted">workspacePath:</span>{" "}
                              <span className="text-text-secondary">{log.workspacePath ?? "—"}</span>
                            </div>
                            <div>
                              <span className="font-medium text-text-muted">workspaceName:</span>{" "}
                              <span className="text-text-secondary">{log.workspaceName ?? "—"}</span>
                            </div>
                            <div>
                              <span className="font-medium text-text-muted">resultSummary:</span>{" "}
                              <span className="text-text-secondary">{log.resultSummary ?? "—"}</span>
                            </div>
                            <div>
                              <span className="font-medium text-text-muted">skipReason:</span>{" "}
                              <span className="text-text-secondary">{log.skipReason ?? "—"}</span>
                            </div>
                            {log.error && (
                              <div>
                                <span className="font-medium text-text-muted">error:</span>{" "}
                                <span className="text-destructive">{log.error}</span>
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                      {logs.length === 0 && (
                        <div className="rounded-md border border-dashed p-6 text-center text-sm text-text-muted">
                          {t("logs.noHistory")}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex min-h-0 flex-col rounded-md border">
                <div className="shrink-0 border-b px-4 py-3">
                  <h3 className="font-medium">{t("logs.runDirectory")}</h3>
                  <p className="text-xs text-text-muted">{workspaceTitle ?? t("logs.directoryHint")}</p>
                </div>
                <div className="min-h-0 overflow-y-auto p-4">
                  {workspaceLoading ? (
                    <Skeleton className="h-24 w-full" />
                  ) : workspaceEntries.length === 0 ? (
                    <div className="text-sm text-text-muted">{t("logs.noDirectoryContent")}</div>
                  ) : (
                    <div className="space-y-2">
                      {workspaceEntries.map((entry) => (
                        <div
                          key={entry.path}
                          className="flex items-start justify-between gap-3 rounded border px-3 py-2 text-sm"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="font-medium text-text-bright">{entry.name}</div>
                            <div className="break-all text-xs text-text-muted" title={entry.path}>
                              {entry.path}
                            </div>
                          </div>
                          <div className="shrink-0 whitespace-nowrap text-right text-xs text-text-muted">
                            {entry.type} · {entry.size} B
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("confirm.deleteTitle")}
        description={t("confirm.deleteDescription", { name: deleteTarget?.name ?? "" })}
        variant="destructive"
        onConfirm={() => deleteTarget && runDelete(deleteTarget.id)}
      />
      <ConfirmDialog
        open={clearLogsConfirmOpen}
        onOpenChange={setClearLogsConfirmOpen}
        title={t("logs.clearTitle")}
        description={t("logs.clearDescription")}
        variant="destructive"
        onConfirm={() => logsTask && runClearLogs(logsTask.id)}
      />
    </div>
  );
}
