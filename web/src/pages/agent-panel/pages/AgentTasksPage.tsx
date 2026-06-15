import { useCallback, useEffect, useState } from "react";
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
import { envApi, fileApi, taskApi } from "@/src/api/sdk";
import { AgentCardList } from "../shared/AgentCardList";
import { AgentPageHeader } from "../shared/AgentPageHeader";

interface TaskInfo {
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

interface ExecutionLogInfo {
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

interface Environment {
  id: string;
  name: string;
  workspace_path: string;
  session_id?: string;
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

function formatLastResult(t: (key: string, options?: Record<string, unknown>) => string, task: TaskInfo): string {
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

function toWorkspaceRelativePath(environment: Environment, workspacePath: string): string {
  const prefix = environment.workspace_path.replace(/\/$/, "");
  if (!workspacePath.startsWith(prefix)) return workspacePath.replace(/^\//, "");
  return workspacePath.slice(prefix.length).replace(/^\/+/, "");
}

export function AgentTasksPage() {
  const { t } = useTranslation("tasks");
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [loading, setLoading] = useState(true);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<TaskInfo | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<TaskInfo | null>(null);

  const [logsTask, setLogsTask] = useState<TaskInfo | null>(null);
  const [logs, setLogs] = useState<ExecutionLogInfo[]>([]);
  const [logsTotal, setLogsTotal] = useState(0);
  const [logsPage, setLogsPage] = useState(1);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsDialogOpen, setLogsDialogOpen] = useState(false);
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
  const [formSaving, setFormSaving] = useState(false);
  const [triggeringTaskId, setTriggeringTaskId] = useState<string | null>(null);
  const totalLogPages = Math.max(1, Math.ceil(logsTotal / 20));

  const loadTasksAndEnvironments = useCallback(async () => {
    setLoading(true);
    try {
      const [taskResult, envResult] = await Promise.all([taskApi.list(), envApi.list()]);
      setTasks(Array.isArray(taskResult.data) ? (taskResult.data as TaskInfo[]) : []);
      setEnvironments(Array.isArray(envResult.data) ? (envResult.data as Environment[]) : []);
    } catch (error) {
      console.error(t("toast.loadPageFailed", { error: "" }), error);
      toast.error(t("toast.loadPageFailed", { error: error instanceof Error ? error.message : t("misc.unknown") }));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    loadTasksAndEnvironments();
  }, [loadTasksAndEnvironments]);

  const loadLogs = useCallback(
    async (taskId: string, page = 1) => {
      setLogsLoading(true);
      try {
        const { data: result } = await taskApi.logs({ id: taskId }, { page, pageSize: 20 });
        const items = (result as { items?: ExecutionLogInfo[]; total?: number } | null)?.items;
        const total = (result as { items?: ExecutionLogInfo[]; total?: number } | null)?.total;
        setLogs(Array.isArray(items) ? items : []);
        setLogsTotal(total ?? 0);
        setLogsPage(page);
      } catch (error) {
        console.error(t("toast.loadLogsFailed", { error: "" }), error);
        toast.error(t("toast.loadLogsFailed", { error: error instanceof Error ? error.message : t("misc.unknown") }));
      } finally {
        setLogsLoading(false);
      }
    },
    [t],
  );

  const resetForm = useCallback(() => {
    setFormName("");
    setFormDescription("");
    setFormCron("*/5 * * * *");
    setFormEnvironmentId(environments[0]?.id ?? "");
    setFormTask("");
    setFormTimeoutMinutes("30");
    setFormEnabled(true);
  }, [environments]);

  const handleOpenCreate = () => {
    setEditingTask(null);
    resetForm();
    setDialogOpen(true);
  };

  const handleOpenEdit = (task: TaskInfo) => {
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

  const handleSave = async () => {
    const error = validateTaskForm(t, formName, formEnvironmentId, formTask, formCron, formTimeoutMinutes);
    if (error) {
      toast.error(error);
      return;
    }
    setFormSaving(true);
    try {
      const payload = {
        name: formName.trim(),
        description: formDescription.trim() || undefined,
        cron: formCron.trim(),
        environmentId: formEnvironmentId,
        task: formTask.trim(),
        timeoutMinutes: Number(formTimeoutMinutes),
        enabled: formEnabled,
      };
      if (editingTask) {
        await taskApi.update({ id: editingTask.id }, payload);
        toast.success(t("toast.taskUpdated"));
      } else {
        await taskApi.create(payload);
        toast.success(t("toast.taskCreated"));
      }
      setDialogOpen(false);
      await loadTasksAndEnvironments();
    } catch (saveError) {
      console.error(t("toast.saveFailed", { error: "" }), saveError);
      toast.error(t("toast.saveFailed", { error: saveError instanceof Error ? saveError.message : t("misc.unknown") }));
    } finally {
      setFormSaving(false);
    }
  };

  const handleToggle = async (task: TaskInfo) => {
    try {
      await taskApi.toggle({ id: task.id });
      toast.success(task.enabled ? t("toast.disabled", { name: task.name }) : t("toast.enabled", { name: task.name }));
      await loadTasksAndEnvironments();
    } catch (error) {
      console.error(t("toast.toggleFailed", { error: "" }), error);
      toast.error(t("toast.toggleFailed", { error: error instanceof Error ? error.message : t("misc.unknown") }));
    }
  };

  const handleTrigger = async (task: TaskInfo) => {
    setTriggeringTaskId(task.id);
    try {
      const { data: result } = await taskApi.trigger({ id: task.id });
      toast.success(
        t("toast.triggerSuccess", {
          status: (result as { status?: string } | null)?.status ?? t("misc.unknown"),
          duration: formatDuration((result as { duration?: number | null } | null)?.duration ?? null),
          directory: (result as { workspaceName?: string } | null)?.workspaceName ?? "—",
        }),
      );
      await loadTasksAndEnvironments();
    } catch (error) {
      console.error(t("toast.triggerFailed", { error: "" }), error);
      toast.error(t("toast.triggerFailed", { error: error instanceof Error ? error.message : t("misc.unknown") }));
    } finally {
      setTriggeringTaskId(null);
    }
  };

  const handleViewLogs = (task: TaskInfo) => {
    setLogsTask(task);
    setLogsDialogOpen(true);
    setWorkspaceEntries([]);
    setWorkspaceTitle(null);
    loadLogs(task.id, 1);
  };

  const handleBrowseWorkspace = async (log: ExecutionLogInfo) => {
    if (!log.workspacePath || !log.environmentId) {
      toast.error(t("toast.noWorkspacePath"));
      return;
    }
    const environment = environments.find((item) => item.id === log.environmentId);
    if (!environment?.session_id) {
      toast.error(t("toast.noEnvSession"));
      return;
    }
    setWorkspaceLoading(true);
    try {
      const relativePath = toWorkspaceRelativePath(environment, log.workspacePath);
      const { data: wsResult } = await fileApi.listDir({ id: environment.session_id! }, { path: relativePath });
      setWorkspaceEntries(
        Array.isArray((wsResult as { entries?: FileInfo[] } | null)?.entries)
          ? ((wsResult as { entries?: FileInfo[] } | null)?.entries ?? [])
          : [],
      );
      setWorkspaceTitle(relativePath);
    } catch (error) {
      console.error(t("toast.viewDirFailed", { error: "" }), error);
      toast.error(t("toast.viewDirFailed", { error: error instanceof Error ? error.message : t("misc.unknown") }));
    } finally {
      setWorkspaceLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await taskApi.delete({ id: deleteTarget.id });
      toast.success(t("toast.taskDeleted"));
      setConfirmOpen(false);
      setDeleteTarget(null);
      await loadTasksAndEnvironments();
    } catch (error) {
      console.error(t("toast.deleteFailed", { error: "" }), error);
      toast.error(t("toast.deleteFailed", { error: error instanceof Error ? error.message : t("misc.unknown") }));
    }
  };

  const handleClearLogs = async () => {
    if (!logsTask) return;
    try {
      await taskApi.clearLogs({ id: logsTask.id });
      toast.success(t("toast.logsCleared"));
      setClearLogsConfirmOpen(false);
      await loadLogs(logsTask.id, 1);
    } catch (error) {
      console.error(t("toast.clearLogsFailed", { error: "" }), error);
      toast.error(t("toast.clearLogsFailed", { error: error instanceof Error ? error.message : t("misc.unknown") }));
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col flex-1 min-h-0 bg-[#f4f7fb]">
        <AgentPageHeader title={t("title")} subtitle={t("subtitle")} />
        <div className="flex-1 overflow-y-auto p-6 space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
            <Skeleton key={i} className="h-20 w-full rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-[#f4f7fb]">
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
                  onClick={() => handleTrigger(task)}
                >
                  {triggeringTaskId === task.id ? "..." : t("actions.executeNow")}
                </Button>
                <Button size="xs" variant="outline" onClick={() => handleViewLogs(task)}>
                  {t("actions.logs")}
                </Button>
                <Button size="xs" variant="outline" onClick={() => handleToggle(task)}>
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
        loading={formSaving}
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
        onConfirm={handleDelete}
      />
      <ConfirmDialog
        open={clearLogsConfirmOpen}
        onOpenChange={setClearLogsConfirmOpen}
        title={t("logs.clearTitle")}
        description={t("logs.clearDescription")}
        variant="destructive"
        onConfirm={handleClearLogs}
      />
    </div>
  );
}
