import { useRequest } from "ahooks";
import { Calendar, ChevronLeft, ChevronRight, FileText, Pencil, Play, Plus, Power, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { z } from "zod/v4";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { EmptyState } from "@/components/config/EmptyState";
import { FormDialog } from "@/components/config/FormDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { agentApi } from "@/src/api/agents";
import type { PaginatedResponse } from "@/src/api/request";
import { unwrap } from "@/src/api/request";
import type {
  AgentDefinition,
  HttpDefinition,
  TaskV2CreateBody,
  TaskV2Info,
  TaskV2UpdateBody,
} from "@/src/api/tasks-v2";
import { taskV2Api } from "@/src/api/tasks-v2";
import { NS } from "@/src/i18n";
import type { AgentInfo } from "@/src/types/config";
import { describeCron } from "../components/CronEditor";
import { TaskForm, type TaskFormValues } from "../components/TaskForm";
import { TaskLogDialog } from "../components/TaskLogDialog";
import { AgentPageHeader } from "../shared/AgentPageHeader";

// ── Zod Schema ──

const formSchema = z
  .object({
    type: z.enum(["http", "agent"]),
    name: z.string().min(1, "名称不能为空"),
    cron: z.string().min(1, "Cron 不能为空"),
    timezone: z.string().optional().default(""),
    timeoutSeconds: z.coerce.number().min(1).max(3600),
    description: z.string().optional().default(""),
    url: z.string().optional().default(""),
    method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).optional().default("POST"),
    headers: z.string().optional().default(""),
    body: z.string().optional().default(""),
    agentId: z.string().optional().default(""),
    prompt: z.string().optional().default(""),
  })
  .superRefine((data, ctx) => {
    if (data.type === "http") {
      if (!data.url.trim()) {
        ctx.addIssue({ code: "custom", path: ["url"], message: "请输入 URL" });
      }
      if (data.headers.trim()) {
        try {
          const parsed = JSON.parse(data.headers);
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            ctx.addIssue({ code: "custom", path: ["headers"], message: "Headers 必须是 JSON 对象" });
          }
        } catch {
          ctx.addIssue({ code: "custom", path: ["headers"], message: "Headers 不是有效的 JSON 格式" });
        }
      }
    }
    if (data.type === "agent") {
      if (!data.agentId.trim()) {
        ctx.addIssue({ code: "custom", path: ["agentId"], message: "请选择 Agent" });
      }
      if (!data.prompt.trim()) {
        ctx.addIssue({ code: "custom", path: ["prompt"], message: "Prompt 不能为空" });
      }
    }
  });

// ── 辅助函数 ──

function buildDefinition(values: TaskFormValues): HttpDefinition | AgentDefinition {
  if (values.type === "http") {
    return {
      url: values.url,
      method: values.method,
      headers: values.headers.trim() ? JSON.parse(values.headers) : undefined,
      body: values.body.trim() || undefined,
    };
  }
  return { prompt: values.prompt };
}

function statusVariant(status: string | null): "default" | "destructive" | "outline" | "secondary" {
  if (status === "success") return "default";
  if (status === "failed" || status === "timeout") return "destructive";
  return "secondary";
}

function formatTime(ts: number | null | undefined): string {
  if (ts == null) return "—";
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ── 默认表单值 / 转换 ──

const INITIAL_FORM_VALUES: TaskFormValues = {
  type: "http",
  name: "",
  cron: "*/5 * * * *",
  timezone: "",
  timeoutSeconds: 300,
  description: "",
  url: "",
  method: "POST",
  headers: "",
  body: "",
  agentId: "",
  prompt: "",
};

function taskToFormValues(task: TaskV2Info): TaskFormValues {
  const def = task.definition as unknown as Record<string, unknown> | null;
  return {
    type: task.type,
    name: task.name,
    cron: task.cron,
    timezone: task.timezone ?? "",
    timeoutSeconds: task.timeoutSeconds,
    description: task.description ?? "",
    url: (def?.url as string) ?? "",
    method: ((def?.method as string) ?? "POST") as "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
    headers: def?.headers ? JSON.stringify(def.headers) : "",
    body: (def?.body as string) ?? "",
    agentId: task.agentId ?? "",
    prompt: (def?.prompt as string) ?? "",
  };
}

// ── 组件 ──

const DEFAULT_PAGE_SIZE = 20;

export function AgentTasksPage() {
  const { t } = useTranslation(NS.TASKS_V2);

  // ── 筛选 + 分页状态 ──
  const [searchKeyword, setSearchKeyword] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | "http" | "agent">("all");
  const [page, setPage] = useState(1);

  // 筛选条件变化时回到第一页
  useEffect(() => {
    setPage(1);
  }, [searchKeyword, typeFilter]);

  // ── 数据加载（服务端分页） ──
  const {
    data: pageData,
    loading,
    refresh,
  } = useRequest(
    async () => {
      const keyword = searchKeyword.trim() || undefined;
      const type = typeFilter !== "all" ? typeFilter : undefined;
      const result = await unwrap(taskV2Api.list({ page, pageSize: DEFAULT_PAGE_SIZE, keyword, type }));
      return result as unknown as PaginatedResponse<TaskV2Info>;
    },
    {
      refreshDeps: [page, searchKeyword, typeFilter],
      onError: (err: Error) => {
        console.error("task list load failed", err);
        toast.error(err.message);
      },
    },
  );
  const tasks: TaskV2Info[] = pageData?.items ?? [];
  const totalTasks = pageData?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalTasks / DEFAULT_PAGE_SIZE));

  // Agent 列表独立加载，失败不影响任务列表
  const { data: agentListData } = useRequest(
    async () => {
      const agentResult = await unwrap(agentApi.list());
      return agentResult.agents ?? [];
    },
    {
      onError: (err: Error) => {
        console.error("agent list load failed", err);
      },
    },
  );
  const agents: AgentInfo[] = agentListData ?? [];

  // ── 对话框状态 ──
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<TaskV2Info | null>(null);

  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<TaskV2Info | null>(null);

  const [logDialogOpen, setLogDialogOpen] = useState(false);
  const [logTask, setLogTask] = useState<TaskV2Info | null>(null);

  const [confirmClearLogsOpen, setConfirmClearLogsOpen] = useState(false);
  const [logRefreshKey, setLogRefreshKey] = useState(0);
  const [formResetKey, setFormResetKey] = useState(0);

  // ── 保存 (创建/更新) ──
  const editingTaskRef = useRef(editingTask);
  editingTaskRef.current = editingTask;
  const isEditingRef = useRef(false);
  isEditingRef.current = !!editingTask;

  const { run: saveTask, loading: saving } = useRequest(
    async (values: TaskFormValues) => {
      const task = editingTaskRef.current;
      const timeoutSeconds = values.timeoutSeconds;
      const base: Omit<TaskV2CreateBody, "definition" | "type"> = {
        name: values.name.trim(),
        description: values.description.trim() || undefined,
        cron: values.cron.trim(),
        timezone: values.timezone || undefined,
        timeoutSeconds,
        agentId: values.type === "agent" ? values.agentId : undefined,
      };
      const definition = buildDefinition(values);

      if (task) {
        await unwrap(
          taskV2Api.update(task.id, {
            ...base,
            definition,
          } as TaskV2UpdateBody),
        );
      } else {
        await unwrap(
          taskV2Api.create({
            ...base,
            type: values.type,
            definition,
          }),
        );
      }
    },
    {
      manual: true,
      onSuccess: () => {
        toast.success(isEditingRef.current ? t("toast.updated") : t("toast.created"));
        setDialogOpen(false);
        setTimeout(() => refresh(), 100);
      },
      onError: (err: Error) => {
        console.error("save task failed", err);
        toast.error(err.message);
      },
    },
  );

  // ── 表单配置 ──
  const formDefaultValues = useMemo<TaskFormValues>(
    () => (editingTask ? taskToFormValues(editingTask) : { ...INITIAL_FORM_VALUES }),
    [editingTask],
  );

  const formConfig = useMemo(
    () => ({
      schema: formSchema as z.ZodType<Record<string, unknown>>,
      defaultValues: formDefaultValues as unknown as Record<string, unknown>,
      onFormSubmit: (data: Record<string, unknown>) => saveTask(data as unknown as TaskFormValues),
    }),
    [formDefaultValues, saveTask],
  );

  // ── 启停切换 ──
  const { run: runToggle } = useRequest((id: string) => unwrap(taskV2Api.toggle(id)), {
    manual: true,
    onSuccess: () => {
      toast.success(t("toast.toggled"));
      refresh();
    },
    onError: (err: Error) => {
      console.error("toggle task failed", err);
      toast.error(err.message);
    },
  });

  // ── 手动触发 ──
  const [triggeredTasks, setTriggeredTasks] = useState<Set<string>>(new Set());

  const { run: runTrigger } = useRequest(
    async (id: string) => {
      return unwrap(taskV2Api.trigger(id));
    },
    {
      manual: true,
      onSuccess: (result) => {
        const r = result as { status?: string; duration?: number; resultSummary?: string };
        toast.success(t("toast.triggerResult", { status: r.status ?? "—", duration: r.duration ?? 0 }));
        refresh();
      },
      onError: (err: Error) => {
        console.error("trigger task failed", err);
        toast.error(err.message);
      },
      onFinally: (_, params) => {
        const id = (Array.isArray(params) ? params[0] : params) as string;
        setTriggeredTasks((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      },
    },
  );

  // ── 删除 ──
  const { run: runDelete, loading: deleting } = useRequest((id: string) => unwrap(taskV2Api.del(id)), {
    manual: true,
    onSuccess: () => {
      setConfirmDeleteOpen(false);
      setDeleteTarget(null);
      toast.success(t("toast.deleted"));
      refresh();
    },
    onError: (err: Error) => {
      console.error("delete task failed", err);
      toast.error(err.message);
    },
  });

  // ── 清空日志 ──
  const { run: runClearLogs, loading: clearingLogs } = useRequest((id: string) => unwrap(taskV2Api.clearLogs(id)), {
    manual: true,
    onSuccess: () => {
      toast.success(t("toast.logsCleared"));
      setConfirmClearLogsOpen(false);
      setLogRefreshKey((k) => k + 1);
    },
    onError: (err: Error) => {
      console.error("clear logs failed", err);
      toast.error(err.message);
    },
  });

  // ── 操作回调 ──
  const handleOpenCreate = useCallback(() => {
    setEditingTask(null);
    setFormResetKey((k) => k + 1);
    setDialogOpen(true);
  }, []);

  const handleOpenEdit = useCallback((task: TaskV2Info) => {
    setEditingTask(task);
    setFormResetKey((k) => k + 1);
    setDialogOpen(true);
  }, []);

  const handleViewLogs = useCallback((task: TaskV2Info) => {
    setLogTask(task);
    setLogDialogOpen(true);
  }, []);

  const handleDeleteClick = useCallback((task: TaskV2Info) => {
    setDeleteTarget(task);
    setConfirmDeleteOpen(true);
  }, []);

  const handleClearLogsClick = useCallback(() => {
    setConfirmClearLogsOpen(true);
  }, []);

  // ── 加载态 ──
  if (loading) {
    return (
      <div className="min-h-full overflow-auto bg-[#f4f7fb] px-8 py-7 text-[#14213d]">
        <AgentPageHeader title={t("title")} subtitle={t("subtitle")} />
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
            <Skeleton key={i} className="h-24 w-full rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full overflow-auto bg-[#f4f7fb] px-8 py-7 text-[#14213d]">
      {/* ── 标题栏 ── */}
      <AgentPageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <Button onClick={handleOpenCreate}>
            <Plus className="mr-1 size-3.5" />
            {t("action.create")}
          </Button>
        }
      />

      {/* ── 搜索 + 类型筛选 ── */}
      <div className="mb-4 flex items-center gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-text-muted" />
          <Input
            placeholder={t("filter.searchPlaceholder")}
            value={searchKeyword}
            onChange={(e) => setSearchKeyword(e.target.value)}
            className="h-8 pl-8 text-xs"
          />
        </div>
        <Tabs value={typeFilter} onValueChange={(v) => setTypeFilter(v as "all" | "http" | "agent")}>
          <TabsList>
            <TabsTrigger
              value="all"
              className="text-xs h-7 data-[state=active]:text-text-bright data-[state=inactive]:text-text-muted"
            >
              {t("filter.all")}
            </TabsTrigger>
            <TabsTrigger
              value="http"
              className="text-xs h-7 data-[state=active]:text-text-bright data-[state=inactive]:text-text-muted"
            >
              {t("type.http")}
            </TabsTrigger>
            <TabsTrigger
              value="agent"
              className="text-xs h-7 data-[state=active]:text-text-bright data-[state=inactive]:text-text-muted"
            >
              {t("type.agent")}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* ── 任务卡片列表 ── */}
      {tasks.length === 0 ? (
        <EmptyState icon={<Calendar className="w-10 h-10" />} title={t("empty")} description={t("subtitle")} />
      ) : (
        <>
          <div className="space-y-3">
            {tasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                t={t}
                triggeringTaskId={triggeredTasks}
                onToggle={() => runToggle(task.id)}
                onTrigger={() => {
                  setTriggeredTasks((prev) => new Set(prev).add(task.id));
                  runTrigger(task.id);
                }}
                onEdit={() => handleOpenEdit(task)}
                onDelete={() => handleDeleteClick(task)}
                onViewLogs={() => handleViewLogs(task)}
              />
            ))}
          </div>

          {/* ── 分页控件 ── */}
          {totalPages > 1 && (
            <div className="mt-4 flex items-center justify-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                <ChevronLeft className="mr-1 size-3" />
                {t("log.prev")}
              </Button>
              <span className="text-xs text-text-muted">
                {page} / {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                {t("log.next")}
                <ChevronRight className="ml-1 size-3" />
              </Button>
            </div>
          )}
        </>
      )}

      {/* ── 创建/编辑表单 ── */}
      <FormDialog
        key={`${editingTask?.id ?? "create"}-${formResetKey}`}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={editingTask ? t("dialog.editTitle", { name: editingTask.name }) : t("dialog.createTitle")}
        width="sm:max-w-2xl"
        formConfig={formConfig}
        loading={saving}
      >
        <TaskForm agents={agents} isEditing={!!editingTask} initialType={editingTask?.type ?? "http"} />
      </FormDialog>

      {/* ── 执行日志弹窗 ── */}
      <TaskLogDialog
        open={logDialogOpen}
        onOpenChange={setLogDialogOpen}
        taskId={logTask?.id ?? ""}
        taskName={logTask?.name ?? ""}
        onClearLogs={handleClearLogsClick}
        refreshKey={logRefreshKey}
      />

      {/* ── 删除确认 ── */}
      <ConfirmDialog
        open={confirmDeleteOpen}
        onOpenChange={setConfirmDeleteOpen}
        title={t("action.delete")}
        description={t("dialog.deleteConfirm", { name: deleteTarget?.name ?? "" })}
        variant="destructive"
        loading={deleting}
        onConfirm={() => deleteTarget && runDelete(deleteTarget.id)}
      />

      {/* ── 清空日志确认 ── */}
      <ConfirmDialog
        open={confirmClearLogsOpen}
        onOpenChange={setConfirmClearLogsOpen}
        title={t("action.clearLogs")}
        description={t("dialog.clearLogsConfirm")}
        variant="destructive"
        loading={clearingLogs}
        onConfirm={() => logTask && runClearLogs(logTask.id)}
      />
    </div>
  );
}

// ── 任务卡片子组件 ──

interface TaskCardProps {
  task: TaskV2Info;
  t: (key: string, options?: Record<string, unknown>) => string;
  triggeringTaskId: Set<string>;
  onToggle: () => void;
  onTrigger: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onViewLogs: () => void;
}

function TaskCard({ task, t, triggeringTaskId, onToggle, onTrigger, onEdit, onDelete, onViewLogs }: TaskCardProps) {
  const cronDesc = describeCron(task.cron, t);

  const typeBadge = (
    <Badge variant={task.type === "agent" ? "default" : "outline"} className="text-[11px] h-5">
      {t(`type.${task.type}`)}
    </Badge>
  );

  const statusBadge = (
    <Badge variant={statusVariant(task.lastStatus)} className="text-[11px] h-5">
      {t(`status.${task.lastStatus || "pending"}`)}
    </Badge>
  );

  return (
    <Card className="px-4 py-3 gap-0">
      <CardContent className="p-0">
        {/* 第一行：名称 + 标签 */}
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium text-text-bright truncate">{task.name}</span>
          <div className="flex items-center gap-1.5 shrink-0">
            {typeBadge}
            {statusBadge}
          </div>
        </div>

        {/* 描述 */}
        {task.description && <p className="mt-1 text-xs text-text-secondary line-clamp-1">{task.description}</p>}

        {/* Cron + 超时 */}
        <div className="mt-1.5 flex items-center gap-3 text-xs text-text-muted">
          <code className="rounded bg-surface-1 px-1.5 py-0.5 text-[11px]">{task.cron}</code>
          {cronDesc && <span className="text-[11px] text-dim">{cronDesc}</span>}
          <span className="text-dim">
            {t("card.label")}: {task.timeoutSeconds}s
          </span>
        </div>

        {/* 上次 / 下次执行 */}
        <div className="mt-1.5 flex items-center gap-4 text-xs text-dim">
          <span>
            {t("card.lastRun")} {formatTime(task.lastRunAt)}
          </span>
          <span>
            {t("card.nextRun")} {formatTime(task.nextRunAt)}
          </span>
        </div>
      </CardContent>

      {/* 按钮行 */}
      <CardFooter className="justify-end gap-1.5 p-0 pt-2.5 mt-2.5 border-t border-border-light">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          disabled={triggeringTaskId.has(task.id)}
          onClick={onTrigger}
        >
          <Play className="mr-1 size-3" />
          {t("action.execute")}
        </Button>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onViewLogs}>
          <FileText className="mr-1 size-3" />
          {t("action.logs")}
        </Button>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onToggle}>
          <Power className="mr-1 size-3" />
          {task.enabled ? t("card.disabled") : t("card.enabled")}
        </Button>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onEdit}>
          <Pencil className="mr-1 size-3" />
          {t("action.edit")}
        </Button>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onDelete}>
          <Trash2 className="mr-1 size-3" />
          {t("action.delete")}
        </Button>
      </CardFooter>
    </Card>
  );
}
