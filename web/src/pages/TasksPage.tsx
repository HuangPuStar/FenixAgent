import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { DataTable, type Column } from "@/components/config/DataTable";
import { FormDialog } from "@/components/config/FormDialog";
import { StatusBadge } from "@/components/config/StatusBadge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  apiClearTaskLogs,
  apiCreateTask,
  apiDeleteTask,
  apiFetchEnvironments,
  apiListFiles,
  apiListTaskLogs,
  apiListTasks,
  apiToggleTask,
  apiTriggerTask,
  apiUpdateTask,
} from "../api/client";
import type { ExecutionLogInfo, TaskInfo } from "../api/client";
import type { Environment, FileInfo } from "../types";

const CRON_PRESETS = [
  { label: "每 5 分钟", value: "*/5 * * * *" },
  { label: "每小时", value: "0 * * * *" },
  { label: "每天早 9 点", value: "0 9 * * *" },
  { label: "工作日早 9 点", value: "0 9 * * 1-5" },
  { label: "每月 1 号", value: "0 0 1 * *" },
];

function validateTaskForm(
  name: string,
  environmentId: string,
  task: string,
  cron: string,
  timeoutMinutes: string,
): string | null {
  if (!name.trim()) return "任务名称不能为空";
  if (!environmentId) return "请选择 Environment";
  if (!task.trim()) return "任务内容不能为空";
  if (!cron.trim()) return "cron 表达式不能为空";
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return "cron 表达式必须为 5 字段（分 时 日 月 周）";

  const timeoutValue = Number(timeoutMinutes);
  if (!Number.isInteger(timeoutValue) || timeoutValue < 1 || timeoutValue > 180) {
    return "timeoutMinutes 必须在 1-180 之间";
  }
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

function formatLastResult(task: TaskInfo): string {
  if (!task.lastStatus) return "—";
  if (task.lastStatus === "skipped") return "已跳过";
  if (task.lastStatus === "timeout") return "超时";
  if (task.lastStatus === "failed") return "失败";
  return "成功";
}

function toWorkspaceRelativePath(environment: Environment, workspacePath: string): string {
  const prefix = environment.workspace_path.replace(/\/$/, "");
  if (!workspacePath.startsWith(prefix)) {
    return workspacePath.replace(/^\//, "");
  }
  return workspacePath.slice(prefix.length).replace(/^\/+/, "");
}

export function TasksPage() {
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
      const [taskData, environmentData] = await Promise.all([
        apiListTasks(),
        apiFetchEnvironments(),
      ]);
      setTasks(taskData);
      setEnvironments(environmentData);
    } catch (error) {
      toast.error(`加载任务页面失败: ${error instanceof Error ? error.message : "未知错误"}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTasksAndEnvironments();
  }, [loadTasksAndEnvironments]);

  const loadLogs = useCallback(async (taskId: string, page = 1) => {
    setLogsLoading(true);
    try {
      const data = await apiListTaskLogs(taskId, page, 20);
      setLogs(data.items);
      setLogsTotal(data.total);
      setLogsPage(page);
    } catch (error) {
      toast.error(`加载执行历史失败: ${error instanceof Error ? error.message : "未知错误"}`);
    } finally {
      setLogsLoading(false);
    }
  }, []);

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
    const error = validateTaskForm(formName, formEnvironmentId, formTask, formCron, formTimeoutMinutes);
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
        await apiUpdateTask(editingTask.id, payload);
        toast.success("任务已更新");
      } else {
        await apiCreateTask(payload);
        toast.success("任务已创建");
      }

      setDialogOpen(false);
      await loadTasksAndEnvironments();
    } catch (saveError) {
      toast.error(`保存失败: ${saveError instanceof Error ? saveError.message : "未知错误"}`);
    } finally {
      setFormSaving(false);
    }
  };

  const handleToggle = async (task: TaskInfo) => {
    try {
      await apiToggleTask(task.id);
      toast.success(task.enabled ? `已禁用 "${task.name}"` : `已启用 "${task.name}"`);
      await loadTasksAndEnvironments();
    } catch (error) {
      toast.error(`操作失败: ${error instanceof Error ? error.message : "未知错误"}`);
    }
  };

  const handleTrigger = async (task: TaskInfo) => {
    setTriggeringTaskId(task.id);
    try {
      const result = await apiTriggerTask(task.id);
      toast.success(`已触发，状态: ${result.status}，耗时: ${formatDuration(result.duration)}，目录: ${result.workspaceName ?? "—"}`);
      await loadTasksAndEnvironments();
    } catch (error) {
      toast.error(`触发失败: ${error instanceof Error ? error.message : "未知错误"}`);
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
      toast.error("当前日志没有可查看的 workspacePath");
      return;
    }

    const environment = environments.find((item) => item.id === log.environmentId);
    if (!environment?.session_id) {
      toast.error("找不到对应的 Environment 会话");
      return;
    }

    setWorkspaceLoading(true);
    try {
      const relativePath = toWorkspaceRelativePath(environment, log.workspacePath);
      const result = await apiListFiles(environment.session_id, relativePath);
      setWorkspaceEntries(result.entries);
      setWorkspaceTitle(relativePath);
    } catch (error) {
      toast.error(`查看目录失败: ${error instanceof Error ? error.message : "未知错误"}`);
    } finally {
      setWorkspaceLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await apiDeleteTask(deleteTarget.id);
      toast.success("任务已删除");
      setConfirmOpen(false);
      setDeleteTarget(null);
      await loadTasksAndEnvironments();
    } catch (error) {
      toast.error(`删除失败: ${error instanceof Error ? error.message : "未知错误"}`);
    }
  };

  const handleClearLogs = async () => {
    if (!logsTask) return;
    try {
      await apiClearTaskLogs(logsTask.id);
      toast.success("执行历史已清空");
      setClearLogsConfirmOpen(false);
      await loadLogs(logsTask.id, 1);
    } catch (error) {
      toast.error(`清空失败: ${error instanceof Error ? error.message : "未知错误"}`);
    }
  };

  const columns: Column<TaskInfo>[] = [
    { key: "name", header: "名称", sortable: true, filterable: true },
    {
      key: "cron",
      header: "Cron 表达式",
      render: (row) => <code className="rounded bg-muted px-2 py-1 text-xs">{row.cron}</code>,
    },
    {
      key: "environmentName",
      header: "Environment",
      filterable: true,
      render: (row) => row.environmentName ?? row.environmentId,
    },
    {
      key: "enabled",
      header: "状态",
      render: (row) => <StatusBadge status={row.enabled ? "enabled" : "disabled"} />,
    },
    {
      key: "lastRunAt",
      header: "上次执行",
      render: (row) => <span className="text-xs">{formatTimestamp(row.lastRunAt)}</span>,
    },
    {
      key: "nextRunAt",
      header: "下次执行",
      render: (row) => <span className="text-xs">{formatTimestamp(row.nextRunAt)}</span>,
    },
    {
      key: "lastStatus",
      header: "最近结果",
      render: (row) => <span className="text-xs">{formatLastResult(row)}</span>,
    },
  ];

  if (loading) {
    return (
      <div className="space-y-4 p-6">
        <div className="flex items-center justify-between">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-9 w-24" />
        </div>
        <div className="rounded-md border">
          <Skeleton className="h-10 w-full rounded-t-md" />
          {Array.from({ length: 5 }).map((_, index) => (
            <Skeleton key={index} className="h-12 w-full rounded-none border-t" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">定时任务</h1>
          <p className="text-sm text-muted-foreground">绑定 Environment，定时执行 Agent 任务。</p>
        </div>
        <Button onClick={handleOpenCreate}>新建任务</Button>
      </div>

      <DataTable
        columns={columns}
        data={tasks}
        searchable
        searchPlaceholder="搜索任务名称或 Environment"
        rowKey={(row) => row.id}
        emptyMessage="暂无定时任务"
        actions={(row) => (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => handleOpenEdit(row)}>编辑</Button>
            <Button size="sm" variant="outline" onClick={() => handleViewLogs(row)}>日志</Button>
            <Button
              size="sm"
              variant="outline"
              disabled={triggeringTaskId === row.id}
              onClick={() => handleTrigger(row)}
            >
              立即执行
            </Button>
            <Button size="sm" variant="outline" onClick={() => handleToggle(row)}>
              {row.enabled ? "禁用" : "启用"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setDeleteTarget(row);
                setConfirmOpen(true);
              }}
            >
              删除
            </Button>
          </div>
        )}
      />

      <FormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={editingTask ? "编辑任务" : "新建任务"}
        onSubmit={handleSave}
        loading={formSaving}
        width="sm:max-w-2xl"
      >
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="task-name">名称</Label>
            <Input id="task-name" value={formName} onChange={(event) => setFormName(event.target.value)} />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="task-description">描述</Label>
            <Input id="task-description" value={formDescription} onChange={(event) => setFormDescription(event.target.value)} />
          </div>

          <div className="grid gap-2">
            <Label>Cron 表达式</Label>
            <div className="flex gap-2">
              <Input value={formCron} onChange={(event) => setFormCron(event.target.value)} />
              <Select value={formCron} onValueChange={setFormCron}>
                <SelectTrigger className="w-40">
                  <SelectValue placeholder="快捷选择" />
                </SelectTrigger>
                <SelectContent>
                  {CRON_PRESETS.map((preset) => (
                    <SelectItem key={preset.value} value={preset.value}>
                      {preset.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-2">
            <Label>Environment</Label>
            <Select value={formEnvironmentId} onValueChange={setFormEnvironmentId}>
              <SelectTrigger>
                <SelectValue placeholder="选择 Environment" />
              </SelectTrigger>
              <SelectContent>
                {environments.map((environment) => (
                  <SelectItem key={environment.id} value={environment.id}>
                    {environment.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label>任务内容</Label>
            <Textarea
              value={formTask}
              onChange={(event) => setFormTask(event.target.value)}
              rows={8}
              placeholder="例如：输出当前目录文件清单到 report.md"
            />
          </div>

          <div className="grid gap-2">
            <Label>超时时间（分钟）</Label>
            <Input
              type="number"
              min={1}
              max={180}
              value={formTimeoutMinutes}
              onChange={(event) => setFormTimeoutMinutes(event.target.value)}
            />
          </div>

          {editingTask && (
            <div className="flex items-center justify-between rounded-md border px-3 py-2">
              <div>
                <p className="text-sm font-medium">启用状态</p>
                <p className="text-xs text-muted-foreground">关闭后不会继续调度，但仍可手动执行。</p>
              </div>
              <Switch checked={formEnabled} onCheckedChange={setFormEnabled} />
            </div>
          )}
        </div>
      </FormDialog>

      <Dialog open={logsDialogOpen} onOpenChange={setLogsDialogOpen}>
        <DialogContent className="flex max-h-[90vh] w-[min(96vw,1100px)] flex-col overflow-hidden p-0 sm:max-w-5xl">
          <DialogHeader className="shrink-0 border-b px-6 py-4">
            <DialogTitle>
              执行历史
              {logsTask ? ` · ${logsTask.name}` : ""}
            </DialogTitle>
          </DialogHeader>

          <div className="flex min-h-0 flex-1 flex-col gap-4 p-6">
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">共 {logsTotal} 条记录</p>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-muted-foreground">
                  第 {logsPage} 页 / 共 {totalLogPages} 页
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!logsTask || logsPage <= 1}
                  onClick={() => logsTask && loadLogs(logsTask.id, logsPage - 1)}
                >
                  上一页
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!logsTask || logs.length < 20}
                  onClick={() => logsTask && loadLogs(logsTask.id, logsPage + 1)}
                >
                  下一页
                </Button>
                <Button size="sm" variant="outline" disabled={!logsTask} onClick={() => setClearLogsConfirmOpen(true)}>
                  清空日志
                </Button>
              </div>
            </div>

            <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(320px,0.9fr)]">
              <div className="flex min-h-0 flex-col rounded-md border">
                <div className="shrink-0 border-b px-4 py-3">
                  <h3 className="font-medium">执行记录</h3>
                  <p className="text-xs text-muted-foreground">记录过多时可在此区域内滚动查看</p>
                </div>
                <div className="min-h-0 overflow-y-auto p-4">
                  {logsLoading ? (
                    <div className="space-y-2">
                      {Array.from({ length: 3 }).map((_, index) => (
                        <Skeleton key={index} className="h-20 w-full" />
                      ))}
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {logs.map((log) => (
                        <div key={log.id} className="rounded-md border p-4">
                          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <StatusBadge
                                status={
                                  log.status === "success"
                                    ? "enabled"
                                    : log.status === "failed" || log.status === "timeout"
                                      ? "disabled"
                                      : "custom"
                                }
                              />
                              <span className="text-sm text-muted-foreground">
                                {formatTimestamp(log.createdAt)} · {log.triggeredBy} · {formatDuration(log.duration)}
                              </span>
                            </div>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={!log.workspacePath || !log.environmentId}
                              onClick={() => handleBrowseWorkspace(log)}
                            >
                              查看目录
                            </Button>
                          </div>

                          <div className="grid gap-2 text-sm">
                            <div><span className="font-medium">workspacePath:</span> {log.workspacePath ?? "—"}</div>
                            <div><span className="font-medium">workspaceName:</span> {log.workspaceName ?? "—"}</div>
                            <div><span className="font-medium">resultSummary:</span> {log.resultSummary ?? "—"}</div>
                            <div><span className="font-medium">skipReason:</span> {log.skipReason ?? "—"}</div>
                            <div><span className="font-medium">error:</span> {log.error ?? "—"}</div>
                          </div>
                        </div>
                      ))}

                      {!logsLoading && logs.length === 0 && (
                        <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                          暂无执行历史
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              <div className="flex min-h-0 flex-col rounded-md border">
                <div className="shrink-0 border-b px-4 py-3">
                  <h3 className="font-medium">运行目录</h3>
                  <p className="text-xs text-muted-foreground">{workspaceTitle ?? "点击上方“查看目录”加载内容"}</p>
                </div>

                <div className="min-h-0 overflow-y-auto p-4">
                  {workspaceLoading ? (
                    <Skeleton className="h-24 w-full" />
                  ) : workspaceEntries.length === 0 ? (
                    <div className="text-sm text-muted-foreground">暂无目录内容</div>
                  ) : (
                    <div className="space-y-2">
                      {workspaceEntries.map((entry) => (
                        <div key={entry.path} className="flex items-start justify-between gap-3 rounded border px-3 py-2 text-sm">
                          <div className="min-w-0 flex-1">
                            <div className="font-medium">{entry.name}</div>
                            <div className="break-all text-xs text-muted-foreground" title={entry.path}>
                              {entry.path}
                            </div>
                          </div>
                          <div className="shrink-0 whitespace-nowrap text-right text-xs text-muted-foreground">
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
        title="删除任务"
        description={`确认删除任务「${deleteTarget?.name ?? ""}」？`}
        variant="destructive"
        onConfirm={handleDelete}
      />

      <ConfirmDialog
        open={clearLogsConfirmOpen}
        onOpenChange={setClearLogsConfirmOpen}
        title="清空日志"
        description="确认清空当前任务的执行历史？"
        variant="destructive"
        onConfirm={handleClearLogs}
      />
    </div>
  );
}
