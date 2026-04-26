import { useState, useCallback, useEffect } from "react";
import { toast } from "sonner";
import { DataTable, type Column } from "@/components/config/DataTable";
import { FormDialog } from "@/components/config/FormDialog";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { StatusBadge } from "@/components/config/StatusBadge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  apiListTasks, apiCreateTask, apiGetTask, apiUpdateTask,
  apiDeleteTask, apiToggleTask, apiTriggerTask,
  apiListTaskLogs, apiClearTaskLogs,
} from "../api/client";
import type { TaskInfo, ExecutionLogInfo } from "../api/client";

const CRON_PRESETS = [
  { label: "每 5 分钟", value: "*/5 * * * *" },
  { label: "每小时", value: "0 * * * *" },
  { label: "每天早 9 点", value: "0 9 * * *" },
  { label: "工作日早 9 点", value: "0 9 * * 1-5" },
  { label: "每月 1 号", value: "0 0 1 * *" },
];

type KeyValueEntry = { key: string; value: string };

function validateTaskForm(name: string, url: string, cron: string): string | null {
  if (!name.trim()) return "任务名称不能为空";
  if (name.length > 128) return "任务名称不能超过 128 字符";
  if (!url.trim()) return "URL 不能为空";
  if (!/^https?:\/\//.test(url)) return "URL 必须以 http:// 或 https:// 开头";
  if (!cron.trim()) return "cron 表达式不能为空";
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return "cron 表达式必须为 5 字段（分 时 日 月 周）";
  return null;
}

function formatTimestamp(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString("zh-CN", {
    month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function TasksPage() {
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<TaskInfo | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const [logsTaskId, setLogsTaskId] = useState<string | null>(null);
  const [logs, setLogs] = useState<ExecutionLogInfo[]>([]);
  const [logsTotal, setLogsTotal] = useState(0);
  const [logsPage, setLogsPage] = useState(1);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsDialogOpen, setLogsDialogOpen] = useState(false);
  const [clearLogsConfirmOpen, setClearLogsConfirmOpen] = useState(false);
  const [responseDialogOpen, setResponseDialogOpen] = useState(false);
  const [selectedResponse, setSelectedResponse] = useState<string | null>(null);

  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formCron, setFormCron] = useState("*/5 * * * *");
  const [formTimezone, setFormTimezone] = useState("UTC");
  const [formUrl, setFormUrl] = useState("");
  const [formMethod, setFormMethod] = useState("GET");
  const [formHeaders, setFormHeaders] = useState<KeyValueEntry[]>([{ key: "", value: "" }]);
  const [formBody, setFormBody] = useState("");
  const [formTimeout, setFormTimeout] = useState("30000");
  const [formRetryEnabled, setFormRetryEnabled] = useState(false);
  const [formRetryCount, setFormRetryCount] = useState("3");
  const [formRetryInterval, setFormRetryInterval] = useState("60");
  const [formSaving, setFormSaving] = useState(false);
  const [triggeringTaskId, setTriggeringTaskId] = useState<string | null>(null);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiListTasks();
      setTasks(data);
    } catch (e) {
      toast.error("加载任务列表失败: " + (e instanceof Error ? e.message : "未知错误"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadTasks(); }, [loadTasks]);

  const loadLogs = useCallback(async (taskId: string, page = 1) => {
    setLogsLoading(true);
    try {
      const data = await apiListTaskLogs(taskId, page, 20);
      setLogs(data.items);
      setLogsTotal(data.total);
      setLogsPage(page);
    } catch (e) {
      toast.error("加载执行历史失败: " + (e instanceof Error ? e.message : "未知错误"));
    } finally {
      setLogsLoading(false);
    }
  }, []);

  const handleOpenCreate = () => {
    setEditingTask(null);
    setFormName("");
    setFormDescription("");
    setFormCron("*/5 * * * *");
    setFormTimezone("UTC");
    setFormUrl("");
    setFormMethod("GET");
    setFormHeaders([{ key: "", value: "" }]);
    setFormBody("");
    setFormTimeout("30000");
    setFormRetryEnabled(false);
    setFormRetryCount("3");
    setFormRetryInterval("60");
    setDialogOpen(true);
  };

  const handleOpenEdit = async (task: TaskInfo) => {
    setEditingTask(task);
    setFormName(task.name);
    setFormDescription(task.description ?? "");
    setFormCron(task.cron);
    setFormTimezone(task.timezone);
    setFormUrl(task.url);
    setFormMethod(task.method);
    setFormHeaders(
      task.headers && Object.keys(task.headers).length > 0
        ? Object.entries(task.headers).map(([key, value]) => ({ key, value }))
        : [{ key: "", value: "" }]
    );
    setFormBody(task.body ?? "");
    setFormTimeout(String(task.timeout));
    setFormRetryEnabled(task.retryEnabled);
    setFormRetryCount(String(task.retryCount));
    setFormRetryInterval(String(task.retryInterval));
    setDialogOpen(true);
  };

  const handleSave = async () => {
    const err = validateTaskForm(formName, formUrl, formCron);
    if (err) { toast.error(err); return; }
    setFormSaving(true);
    try {
      const headersObj: Record<string, string> | null =
        formHeaders.filter((h) => h.key.trim()).length > 0
          ? Object.fromEntries(formHeaders.filter((h) => h.key.trim()).map((h) => [h.key, h.value]))
          : null;
      const payload: Partial<TaskInfo> = {
        name: formName,
        description: formDescription || null,
        cron: formCron,
        timezone: formTimezone,
        url: formUrl,
        method: formMethod,
        headers: headersObj,
        body: ["POST", "PUT", "PATCH"].includes(formMethod) && formBody.trim() ? formBody.trim() : null,
        timeout: parseInt(formTimeout, 10) || 30000,
        retryEnabled: formRetryEnabled,
        retryCount: parseInt(formRetryCount, 10) || 3,
        retryInterval: parseInt(formRetryInterval, 10) || 60,
      };
      if (editingTask) {
        await apiUpdateTask(editingTask.id, payload);
        toast.success("任务已更新");
      } else {
        await apiCreateTask(payload);
        toast.success("任务已创建");
      }
      setDialogOpen(false);
      loadTasks();
    } catch (e) {
      toast.error("保存失败: " + (e instanceof Error ? e.message : "未知错误"));
    } finally {
      setFormSaving(false);
    }
  };

  const handleToggle = async (task: TaskInfo) => {
    try {
      await apiToggleTask(task.id);
      toast.success(task.enabled ? `已禁用 "${task.name}"` : `已启用 "${task.name}"`);
      loadTasks();
    } catch (e) {
      toast.error("操作失败: " + (e instanceof Error ? e.message : "未知错误"));
    }
  };

  const handleTrigger = async (task: TaskInfo) => {
    setTriggeringTaskId(task.id);
    try {
      const result = await apiTriggerTask(task.id);
      toast.success(`任务已触发，状态: ${result.status}，耗时: ${formatDuration(result.duration)}`);
      loadTasks();
    } catch (e) {
      toast.error("触发失败: " + (e instanceof Error ? e.message : "未知错误"));
    } finally {
      setTriggeringTaskId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await apiDeleteTask(deleteTarget);
      toast.success("任务已删除");
      setConfirmOpen(false);
      loadTasks();
    } catch (e) {
      toast.error("删除失败: " + (e instanceof Error ? e.message : "未知错误"));
    }
  };

  const handleViewLogs = (task: TaskInfo) => {
    setLogsTaskId(task.id);
    setLogsDialogOpen(true);
    loadLogs(task.id, 1);
  };

  const confirmClearLogs = async () => {
    if (!logsTaskId) return;
    try {
      await apiClearTaskLogs(logsTaskId);
      toast.success("执行历史已清空");
      setClearLogsConfirmOpen(false);
      loadLogs(logsTaskId, 1);
    } catch (e) {
      toast.error("清空失败: " + (e instanceof Error ? e.message : "未知错误"));
    }
  };

  const columns: Column<TaskInfo>[] = [
    {
      key: "name",
      header: "名称",
      sortable: true,
      filterable: true,
    },
    {
      key: "cron",
      header: "Cron 表达式",
      render: (row) => (
        <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">{row.cron}</code>
      ),
    },
    {
      key: "method",
      header: "请求",
      render: (row) => (
        <span className="text-xs">
          <span className="font-semibold text-blue-600">{row.method}</span>{" "}
          <span className="text-muted-foreground truncate max-w-[200px] inline-block align-bottom" title={row.url}>
            {row.url.replace(/^https?:\/\//, "").split("/")[0]}
          </span>
        </span>
      ),
    },
    {
      key: "enabled",
      header: "状态",
      filterable: true,
      render: (row) => <StatusBadge status={row.enabled ? "enabled" : "disabled"} />,
    },
    {
      key: "lastRunAt",
      header: "上次执行",
      sortable: true,
      render: (row) => (
        <div className="text-xs">
          {formatTimestamp(row.lastRunAt)}
          {row.lastStatus && (
            <StatusBadge
              status={row.lastStatus === "success" ? "enabled" : row.lastStatus === "failed" ? "disabled" : row.lastStatus}
            />
          )}
        </div>
      ),
    },
    {
      key: "nextRunAt",
      header: "下次执行",
      render: (row) => <span className="text-xs">{formatTimestamp(row.nextRunAt)}</span>,
    },
  ];

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-9 w-24" />
        </div>
        <div className="rounded-md border">
          <Skeleton className="h-10 w-full rounded-t-md" />
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-none border-t" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">定时任务管理</h2>
        <Button onClick={handleOpenCreate}>新建任务</Button>
      </div>
      <DataTable<TaskInfo>
        columns={columns}
        data={tasks}
        searchable
        searchPlaceholder="搜索任务..."
        rowKey={(row) => row.id}
        actions={(row) => (
          <div className="flex gap-2">
            <Button size="sm" variant="outline"
              disabled={triggeringTaskId === row.id}
              onClick={() => handleTrigger(row)}>
              {triggeringTaskId === row.id ? "触发中..." : "手动触发"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => handleViewLogs(row)}>
              执行历史
            </Button>
            <Button size="sm" variant="outline" onClick={() => handleToggle(row)}>
              {row.enabled ? "禁用" : "启用"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => handleOpenEdit(row)}>编辑</Button>
            <Button size="sm" variant="destructive"
              onClick={() => { setDeleteTarget(row.id); setConfirmOpen(true); }}>删除</Button>
          </div>
        )}
      />

      <FormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={editingTask ? "编辑定时任务" : "新建定时任务"}
        onSubmit={handleSave}
        loading={formSaving}
        width="sm:max-w-2xl">
        <div className="space-y-4">
          <div>
            <Label>名称 *</Label>
            <Input value={formName} onChange={(e) => setFormName(e.target.value)}
              placeholder="例如：每日健康检查" />
          </div>
          <div>
            <Label>描述</Label>
            <Input value={formDescription} onChange={(e) => setFormDescription(e.target.value)}
              placeholder="可选的任务描述" />
          </div>

          <div className="border-t pt-4">
            <h3 className="text-sm font-medium mb-2">调度配置</h3>
            <div className="space-y-2">
              <div>
                <Label>Cron 表达式 *</Label>
                <Input value={formCron} onChange={(e) => setFormCron(e.target.value)}
                  placeholder="*/5 * * * *" className="font-mono" />
                <div className="flex flex-wrap gap-1 mt-1">
                  {CRON_PRESETS.map((preset) => (
                    <button key={preset.value} type="button"
                      className="text-xs px-2 py-0.5 rounded border hover:bg-muted"
                      onClick={() => setFormCron(preset.value)}>
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <Label>时区</Label>
                <Select value={formTimezone} onValueChange={setFormTimezone}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="UTC">UTC</SelectItem>
                    <SelectItem value="Asia/Shanghai">Asia/Shanghai (CST)</SelectItem>
                    <SelectItem value="America/New_York">America/New_York (EST)</SelectItem>
                    <SelectItem value="Europe/London">Europe/London (GMT)</SelectItem>
                    <SelectItem value="Asia/Tokyo">Asia/Tokyo (JST)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          <div className="border-t pt-4">
            <h3 className="text-sm font-medium mb-2">HTTP 配置</h3>
            <div className="space-y-2">
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <Label>方法</Label>
                  <Select value={formMethod} onValueChange={setFormMethod}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="GET">GET</SelectItem>
                      <SelectItem value="POST">POST</SelectItem>
                      <SelectItem value="PUT">PUT</SelectItem>
                      <SelectItem value="DELETE">DELETE</SelectItem>
                      <SelectItem value="PATCH">PATCH</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="col-span-2">
                  <Label>URL *</Label>
                  <Input value={formUrl} onChange={(e) => setFormUrl(e.target.value)}
                    placeholder="https://api.example.com/health" />
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <Label>请求头</Label>
                  <Button type="button" size="sm" variant="outline"
                    onClick={() => setFormHeaders([...formHeaders, { key: "", value: "" }])}>
                    添加
                  </Button>
                </div>
                {formHeaders.map((entry, idx) => (
                  <div key={idx} className="flex gap-2 mb-2 items-center">
                    <Input placeholder="Header Name" value={entry.key}
                      onChange={(e) => {
                        const next = [...formHeaders];
                        next[idx] = { ...next[idx], key: e.target.value };
                        setFormHeaders(next);
                      }} className="flex-1" />
                    <Input placeholder="Header Value" value={entry.value}
                      onChange={(e) => {
                        const next = [...formHeaders];
                        next[idx] = { ...next[idx], value: e.target.value };
                        setFormHeaders(next);
                      }} className="flex-1" />
                    <Button type="button" size="sm" variant="ghost"
                      onClick={() => setFormHeaders(formHeaders.filter((_, i) => i !== idx))}>
                      删除
                    </Button>
                  </div>
                ))}
              </div>
              {["POST", "PUT", "PATCH"].includes(formMethod) && (
                <div>
                  <Label>请求体 (JSON)</Label>
                  <textarea
                    className="w-full min-h-[80px] rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
                    value={formBody}
                    onChange={(e) => setFormBody(e.target.value)}
                    placeholder='{"key": "value"}' />
                </div>
              )}
              <div>
                <Label>超时时间 (ms)</Label>
                <Input type="number" value={formTimeout}
                  onChange={(e) => setFormTimeout(e.target.value)}
                  placeholder="30000" min={1000} max={300000} />
              </div>
            </div>
          </div>

          <div className="border-t pt-4">
            <h3 className="text-sm font-medium mb-2">重试配置</h3>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Switch checked={formRetryEnabled}
                  onCheckedChange={setFormRetryEnabled} />
                <Label>启用自动重试</Label>
              </div>
              {formRetryEnabled && (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>重试次数</Label>
                    <Input type="number" value={formRetryCount}
                      onChange={(e) => setFormRetryCount(e.target.value)}
                      placeholder="3" min={1} max={10} />
                  </div>
                  <div>
                    <Label>重试间隔 (秒)</Label>
                    <Input type="number" value={formRetryInterval}
                      onChange={(e) => setFormRetryInterval(e.target.value)}
                      placeholder="60" min={10} max={3600} />
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </FormDialog>

      <ConfirmDialog open={confirmOpen} onOpenChange={setConfirmOpen}
        title="确认删除" description="此操作不可逆。确定要删除这个定时任务吗？所有执行历史也将被删除。"
        variant="destructive" onConfirm={confirmDelete} />

      <FormDialog open={logsDialogOpen} onOpenChange={setLogsDialogOpen}
        title="执行历史" onSubmit={() => {}} width="sm:max-w-3xl">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">共 {logsTotal} 条记录</span>
            <div className="flex gap-2">
              <Button size="sm" variant="destructive"
                onClick={() => setClearLogsConfirmOpen(true)}
                disabled={logsTotal === 0}>
                清空历史
              </Button>
            </div>
          </div>
          {logsLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : logs.length === 0 ? (
            <div className="text-sm text-muted-foreground py-4 text-center">暂无执行记录</div>
          ) : (
            <div className="rounded-md border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-3 py-2 text-left">时间</th>
                    <th className="px-3 py-2 text-left">状态</th>
                    <th className="px-3 py-2 text-left">状态码</th>
                    <th className="px-3 py-2 text-left">耗时</th>
                    <th className="px-3 py-2 text-left">触发方式</th>
                    <th className="px-3 py-2 text-left">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => (
                    <tr key={log.id} className="border-b last:border-0 hover:bg-muted/20">
                      <td className="px-3 py-2 text-xs">{formatTimestamp(log.createdAt)}</td>
                      <td className="px-3 py-2">
                        <StatusBadge
                          status={log.status === "success" ? "enabled" : log.status === "failed" ? "disabled" : log.status}
                        />
                      </td>
                      <td className="px-3 py-2 text-xs font-mono">{log.statusCode ?? "—"}</td>
                      <td className="px-3 py-2 text-xs">{formatDuration(log.duration)}</td>
                      <td className="px-3 py-2 text-xs">{log.triggeredBy}</td>
                      <td className="px-3 py-2">
                        {log.responseBody && (
                          <Button size="sm" variant="outline"
                            onClick={() => { setSelectedResponse(log.responseBody); setResponseDialogOpen(true); }}>
                            查看响应
                          </Button>
                        )}
                        {log.error && (
                          <span className="text-xs text-destructive" title={log.error}>错误</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {logsTotal > 20 && (
            <div className="flex items-center justify-between">
              <Button size="sm" variant="outline"
                disabled={logsPage <= 1}
                onClick={() => logsTaskId && loadLogs(logsTaskId, logsPage - 1)}>
                上一页
              </Button>
              <span className="text-sm text-muted-foreground">
                第 {logsPage} 页，共 {Math.ceil(logsTotal / 20)} 页
              </span>
              <Button size="sm" variant="outline"
                disabled={logsPage >= Math.ceil(logsTotal / 20)}
                onClick={() => logsTaskId && loadLogs(logsTaskId, logsPage + 1)}>
                下一页
              </Button>
            </div>
          )}
        </div>
      </FormDialog>

      <FormDialog open={responseDialogOpen} onOpenChange={setResponseDialogOpen}
        title="响应体" onSubmit={() => {}} width="sm:max-w-2xl">
        <pre className="text-xs bg-muted p-4 rounded overflow-auto max-h-[400px] whitespace-pre-wrap break-all">
          {(() => {
            try { return selectedResponse ? JSON.stringify(JSON.parse(selectedResponse), null, 2) : "无内容"; }
            catch { return selectedResponse ?? "无内容"; }
          })()}
        </pre>
      </FormDialog>

      <ConfirmDialog open={clearLogsConfirmOpen} onOpenChange={setClearLogsConfirmOpen}
        title="确认清空" description="此操作不可逆。确定要清空所有执行历史吗？"
        variant="destructive" onConfirm={confirmClearLogs} />
    </div>
  );
}
