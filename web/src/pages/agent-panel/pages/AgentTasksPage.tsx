import { useRequest } from "ahooks";
import {
  Calendar,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  FileText,
  Loader2,
  MinusCircle,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Search,
  Trash2,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { z } from "zod/v4";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { EmptyState } from "@/components/config/EmptyState";
import { FormDialog } from "@/components/config/FormDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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

/** 相对时间格式化：Unix 秒级时间戳 -> 人类可读 */
function formatRelativeTime(
  ts: number | null | undefined,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (ts == null) return "—";
  const now = Date.now();
  const diff = now - ts * 1000;
  if (diff < 60_000) return t("relativeTime.justNow");
  if (diff < 3_600_000) return t("relativeTime.minutesAgo", { count: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t("relativeTime.hoursAgo", { count: Math.floor(diff / 3_600_000) });
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
  const [debouncedKeyword, setDebouncedKeyword] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | "http" | "agent">("all");
  const [page, setPage] = useState(1);

  // 搜索防抖：输入即时更新 UI，API 请求 300ms 后触发
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedKeyword(searchKeyword), 300);
    return () => clearTimeout(timer);
  }, [searchKeyword]);

  // 筛选条件或搜索词变化时，重置到第 1 页
  // biome-ignore lint/correctness/useExhaustiveDependencies: 筛选/搜索变化时需重置页码，但 effect 体只用 setPage
  useEffect(() => {
    setPage(1);
  }, [debouncedKeyword, typeFilter]);

  // ── 数据加载（服务端分页） ──
  const {
    data: pageData,
    loading,
    refresh,
  } = useRequest(
    async () => {
      const keyword = debouncedKeyword.trim() || undefined;
      const type = typeFilter !== "all" ? typeFilter : undefined;
      const result = await unwrap(taskV2Api.list({ page, pageSize: DEFAULT_PAGE_SIZE, keyword, type }));
      return result as unknown as PaginatedResponse<TaskV2Info>;
    },
    {
      refreshDeps: [page, debouncedKeyword, typeFilter],
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
  // 仅初次加载时展示全屏骨架屏，后续搜索/筛选触发的 loading 保留下方 UI 避免输入框失焦
  const initialLoadDone = useRef(false);
  if (!initialLoadDone.current && loading) {
    return (
      <div className="min-h-full overflow-auto bg-[#f4f7fb] px-8 py-7 text-[#14213d]">
        <AgentPageHeader title={t("title")} subtitle={t("subtitle")} />
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
            <Skeleton key={i} className="h-12 w-full rounded-lg" />
          ))}
        </div>
      </div>
    );
  }
  // 首次加载完成后标记，后续 loading 不再替换整棵树
  if (!initialLoadDone.current && !loading) {
    initialLoadDone.current = true;
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
          <TaskSearchInput
            placeholder={t("filter.searchPlaceholder")}
            value={searchKeyword}
            onChange={setSearchKeyword}
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

      {/* ── 任务表格 ── */}
      {tasks.length === 0 ? (
        searchKeyword.trim() ? (
          <div className="py-12 text-center text-sm text-text-muted">{t("emptySearchResult")}</div>
        ) : (
          <EmptyState
            icon={<Calendar className="w-10 h-10" />}
            title={t("empty")}
            description={t("subtitle")}
            action={{ label: t("action.create"), onClick: handleOpenCreate }}
          />
        )
      ) : (
        <>
          <div className="rounded-lg border border-border/40 bg-white overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-8" />
                  <TableHead className="text-xs">{t("table.name")}</TableHead>
                  <TableHead className="text-xs w-[80px]">{t("table.type")}</TableHead>
                  <TableHead className="text-xs">{t("table.target")}</TableHead>
                  <TableHead className="text-xs">{t("table.schedule")}</TableHead>
                  <TableHead className="text-xs w-[160px]">{t("table.lastRun")}</TableHead>
                  <TableHead className="text-xs w-[140px] text-right">{t("table.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tasks.map((task) => (
                  <TaskTableRow
                    key={task.id}
                    task={task}
                    agents={agents}
                    t={t}
                    isTriggering={triggeredTasks.has(task.id)}
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
              </TableBody>
            </Table>
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

// ── 搜索输入（IME 安全）：composing 期间使用独立 value 避免 React 受控值覆盖 IME 中间文字 ──

function TaskSearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  const [isComposing, setIsComposing] = useState(false);
  const [composingValue, setComposingValue] = useState("");

  return (
    <Input
      placeholder={placeholder}
      value={isComposing ? composingValue : value}
      className="h-8 pl-8 text-xs"
      onCompositionStart={() => {
        setIsComposing(true);
        setComposingValue(value);
      }}
      onCompositionUpdate={(e) => {
        setComposingValue((e.target as HTMLInputElement).value);
      }}
      onCompositionEnd={(e) => {
        setIsComposing(false);
        setComposingValue("");
        onChange((e.target as HTMLInputElement).value);
      }}
      onChange={(e) => {
        if (isComposing) {
          setComposingValue(e.target.value);
        } else {
          onChange(e.target.value);
        }
      }}
    />
  );
}

// ── 表格行子组件 ──

interface TaskTableRowProps {
  task: TaskV2Info;
  agents: AgentInfo[];
  t: (key: string, options?: Record<string, unknown>) => string;
  isTriggering: boolean;
  onToggle: () => void;
  onTrigger: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onViewLogs: () => void;
}

/** 上次执行状态图标 */
function LastRunStatus({
  status,
  t,
}: {
  status: string | null;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  if (!status) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-text-muted">
        <MinusCircle className="size-3.5" />
        <span>{t("status.pending")}</span>
      </div>
    );
  }
  if (status === "success") {
    return (
      <div className="flex items-center gap-1.5 text-xs text-emerald-600">
        <CheckCircle2 className="size-3.5" />
      </div>
    );
  }
  if (status === "failed") {
    return (
      <div className="flex items-center gap-1.5 text-xs text-red-500">
        <XCircle className="size-3.5" />
      </div>
    );
  }
  if (status === "timeout") {
    return (
      <div className="flex items-center gap-1.5 text-xs text-amber-500">
        <Clock className="size-3.5" />
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5 text-xs text-text-muted">
      <MinusCircle className="size-3.5" />
    </div>
  );
}

function TaskTableRow({
  task,
  agents,
  t,
  isTriggering,
  onToggle,
  onTrigger,
  onEdit,
  onDelete,
  onViewLogs,
}: TaskTableRowProps) {
  const cronDesc = describeCron(task.cron, t);

  // 目标列：Agent 显示名称，HTTP 显示 URL
  const targetLabel = (() => {
    if (task.type === "agent") {
      const agent = agents.find((a) => a.id === task.agentId);
      return agent?.name ?? task.agentId ?? "—";
    }
    const def = task.definition as HttpDefinition | null;
    return def?.url ?? "—";
  })();

  return (
    <TableRow className={!task.enabled ? "opacity-50" : ""}>
      {/* 状态圆点 */}
      <TableCell className="w-8 pr-0">
        <span
          className={`inline-block size-2 rounded-full ${task.enabled ? "bg-emerald-500" : "bg-slate-400"}`}
          title={task.enabled ? t("card.enabled") : t("card.disabled")}
        />
      </TableCell>

      {/* 名称 + 描述 */}
      <TableCell>
        <button type="button" className="text-left cursor-pointer hover:underline" onClick={onEdit}>
          <span className="text-sm font-medium text-text-bright">{task.name}</span>
        </button>
        {task.description && <p className="text-xs text-text-muted truncate max-w-[240px]">{task.description}</p>}
      </TableCell>

      {/* 类型 */}
      <TableCell>
        <Badge variant={task.type === "agent" ? "default" : "outline"} className="text-[11px] h-5">
          {t(`type.${task.type}`)}
        </Badge>
      </TableCell>

      {/* 目标（Agent 名称 / HTTP URL） */}
      <TableCell>
        <span className="text-xs text-text-secondary truncate max-w-[200px] block" title={targetLabel}>
          {targetLabel}
        </span>
      </TableCell>

      {/* 执行计划 */}
      <TableCell>
        <div className="text-xs">
          {cronDesc && <span className="text-text-primary">{cronDesc}</span>}
          <code className="ml-1.5 rounded bg-surface-1 px-1 py-0.5 text-[10px] text-text-muted font-mono">
            {task.cron}
          </code>
        </div>
      </TableCell>

      {/* 上次执行 */}
      <TableCell>
        <div className="flex items-center gap-1.5">
          <LastRunStatus status={task.lastStatus} t={t} />
          <span className="text-xs text-text-muted">{formatRelativeTime(task.lastRunAt, t)}</span>
        </div>
      </TableCell>

      {/* 操作 */}
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1">
          {/* 手动执行 */}
          <Button
            variant="ghost"
            size="sm"
            className="size-7 p-0"
            disabled={isTriggering}
            onClick={onTrigger}
            title={t("action.execute")}
          >
            {isTriggering ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
          </Button>

          {/* 更多菜单 */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="size-7 p-0">
                <MoreHorizontal className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onEdit}>
                <Pencil className="size-3.5" />
                {t("action.edit")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onViewLogs}>
                <FileText className="size-3.5" />
                {t("action.logs")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={onDelete}>
                <Trash2 className="size-3.5" />
                {t("action.delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* 启停 Switch */}
          <Switch
            checked={task.enabled}
            onCheckedChange={onToggle}
            size="sm"
            aria-label={task.enabled ? t("card.disabled") : t("card.enabled")}
          />
        </div>
      </TableCell>
    </TableRow>
  );
}
