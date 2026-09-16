import { useRequest } from "ahooks";
import { Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { z } from "zod/v4";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { FormDialog } from "@/components/config/FormDialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { agentApi } from "@/src/api/agents";
import type { PaginatedResponse } from "@/src/api/request";
import { unwrap } from "@/src/api/request";
import type { TaskV2CreateBody, TaskV2Info, TaskV2UpdateBody } from "@/src/api/tasks-v2";
import { taskV2Api } from "@/src/api/tasks-v2";
import { AppHeader } from "@/src/components/layout/app-header";
import { AppPage } from "@/src/components/layout/app-page";
import { NS } from "@/src/i18n";
import type { AgentInfo } from "@/src/types/config";
import { TaskForm, type TaskFormValues } from "../components/TaskForm";
import { TaskLogDialog } from "../components/TaskLogDialog";
import { AgentTaskRuntimeBoard } from "./agent-task-runtime-board";
import { AgentTasksRegistry, AgentTasksToolbar } from "./agent-tasks-registry";
import { buildTaskDefinition, INITIAL_TASK_FORM_VALUES, taskFormSchema, taskToFormValues } from "./agent-tasks-utils";
import "./agent-tasks.css";

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
      const definition = buildTaskDefinition(values);

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
    () => (editingTask ? taskToFormValues(editingTask) : { ...INITIAL_TASK_FORM_VALUES }),
    [editingTask],
  );

  const formConfig = useMemo(
    () => ({
      mode: "onChange" as const,
      schema: taskFormSchema as z.ZodType<Record<string, unknown>>,
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
        const msg = t("toast.triggerResult", { status: r.status ?? "—", duration: r.duration ?? 0 });
        if (r.status === "success") {
          toast.success(msg);
        } else if (r.status === "timeout") {
          toast.warning(msg);
        } else {
          toast.error(msg);
        }
        refresh();
      },
      onError: (err: Error) => {
        console.error("trigger task failed", err);
        toast.error(err.message);
      },
      // ahooks v3 onFinally 签名: (params, data, error)，第一个参数是输入参数
      onFinally: (params) => {
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
        <AppHeader title={t("title")} subtitle={t("subtitle")} />
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
    <AppPage className="agent-tasks-page">
      {/* ── 标题栏 ── */}
      <AppHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <Button onClick={handleOpenCreate}>
            <Plus className="mr-1 size-3.5" />
            {t("action.create")}
          </Button>
        }
      />

      <AgentTasksToolbar
        query={searchKeyword}
        typeFilter={typeFilter}
        onQueryChange={setSearchKeyword}
        onTypeFilterChange={setTypeFilter}
      />
      <AgentTaskRuntimeBoard tasks={tasks} loading={loading} />
      <AgentTasksRegistry
        tasks={tasks}
        agents={agents}
        query={searchKeyword}
        page={page}
        totalPages={totalPages}
        triggeringIds={triggeredTasks}
        onPageChange={setPage}
        onCreate={handleOpenCreate}
        onToggle={(task) => runToggle(task.id)}
        onTrigger={(task) => {
          setTriggeredTasks((current) => new Set(current).add(task.id));
          runTrigger(task.id);
        }}
        onEdit={handleOpenEdit}
        onDelete={handleDeleteClick}
        onLogs={handleViewLogs}
      />

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
    </AppPage>
  );
}
