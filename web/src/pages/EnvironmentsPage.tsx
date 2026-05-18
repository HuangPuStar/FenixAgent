import {
  ArrowRight,
  Bot,
  ChevronDown,
  LayoutGrid,
  List,
  Loader2,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  RotateCw,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { client } from "../api/client";
import type { Environment, EnvironmentInstance } from "../types";
import { AgentsPage } from "./AgentsPage";

interface EnvironmentsPageProps {
  onNavigateToSession?: (sessionId: string, options?: { cwd?: string }) => void;
}

export function EnvironmentsPage({ onNavigateToSession }: EnvironmentsPageProps) {
  const [envs, setEnvs] = useState<Environment[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingEnv, setEditingEnv] = useState<Environment | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [formSaving, setFormSaving] = useState(false);
  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formWorkspacePath, setFormWorkspacePath] = useState("");
  const [formAgentConfigId, setFormAgentConfigId] = useState("");
  const [formAutoStart, setFormAutoStart] = useState(false);
  const [formError, setFormError] = useState("");
  const [secretDialogOpen, setSecretDialogOpen] = useState(false);
  const [currentSecret, setCurrentSecret] = useState<string | null>(null);
  const [secretCopied, setSecretCopied] = useState(false);
  const [agentOptions, setAgentOptions] = useState<{ id: string; name: string }[]>([]);
  const [enteringEnvId, setEnteringEnvId] = useState<string | null>(null);
  const [instancesMap, setInstancesMap] = useState<Record<string, EnvironmentInstance[]>>({});
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false);
  const [stopTarget, setStopTarget] = useState<{
    instanceId: string;
    envName: string;
  } | null>(null);
  const [refreshingEnvId, setRefreshingEnvId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"table" | "card">("table");
  const [envTab, setEnvTab] = useState<"environments" | "subagents">("environments");

  const loadAgentOptions = useCallback(async () => {
    try {
      const { data, error: err } = await client.web.config.agents.post({ action: "list" });
      if (err || !data) return;
      const result = data as { data?: { agents?: Array<{ id: string; name: string }> } } | null;
      setAgentOptions((result?.data?.agents ?? []).map((a) => ({ id: a.id, name: a.name })));
    } catch {
      /* silent */
    }
  }, []);

  const loadEnvs = useCallback(async () => {
    try {
      const { data, error: err } = await client.web.environments.get();
      if (err) {
        console.error("Failed to load environments:", err);
        return;
      }
      const list = Array.isArray(data) ? (data as unknown as Environment[]) : [];
      setEnvs(list);
      // Load instances for environments that have active instances
      const activeEnvs = list.filter((e) => e.instances_count !== undefined && e.instances_count > 0);
      if (activeEnvs.length > 0) {
        const instanceEntries = await Promise.allSettled(
          activeEnvs.map((env) => client.web.environments({ id: env.id }).instances.get()),
        );
        const newMap: Record<string, EnvironmentInstance[]> = {};
        activeEnvs.forEach((env, i) => {
          const result = instanceEntries[i];
          if (result.status === "fulfilled") {
            const instData = result.value.data as { instances?: EnvironmentInstance[] } | null;
            newMap[env.id] = instData?.instances ?? [];
          }
        });
        setInstancesMap((prev) => ({ ...prev, ...newMap }));
      }
    } catch (err) {
      console.error("Failed to load environments:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadEnvs();
    loadAgentOptions();
  }, [loadEnvs, loadAgentOptions]);

  const openCreateDialog = useCallback(async () => {
    await loadAgentOptions();
    setEditingEnv(null);
    setFormName("");
    setFormDescription("");
    setFormWorkspacePath("");
    setFormAgentConfigId("");
    setFormAutoStart(false);
    setFormError("");
    setDialogOpen(true);
  }, [loadAgentOptions]);

  const openEditDialog = useCallback(
    async (env: Environment) => {
      await loadAgentOptions();
      setEditingEnv(env);
      setFormName(env.name);
      setFormDescription(env.description || "");
      setFormWorkspacePath(env.workspace_path);
      setFormAgentConfigId(env.agent_config_id || "");
      setFormAutoStart(env.auto_start ?? false);
      setFormError("");
      setDialogOpen(true);
    },
    [loadAgentOptions],
  );

  const handleFormSubmit = useCallback(async () => {
    if (!formName || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(formName)) {
      setFormError("名称必须为 kebab-case 格式（小写字母、数字、连字符）");
      return;
    }
    if (!formWorkspacePath.startsWith("/")) {
      setFormError("workspace 路径必须是绝对路径");
      return;
    }
    setFormError("");

    setFormSaving(true);
    try {
      if (editingEnv) {
        const { error: err } = await client.web.environments({ id: editingEnv.id }).put({
          name: formName,
          description: formDescription || undefined,
          workspacePath: formWorkspacePath,
          agentConfigId: formAgentConfigId || null,
          autoStart: formAutoStart,
        });
        if (err) throw new Error(err.message ?? "更新失败");
      } else {
        const { data, error: err } = await client.web.environments.post({
          name: formName,
          description: formDescription || undefined,
          workspacePath: formWorkspacePath,
          agentConfigId: formAgentConfigId || undefined,
          autoStart: formAutoStart,
        });
        if (err) throw new Error(err.message ?? "创建失败");
        const result = data as { secret?: string } | null;
        setCurrentSecret(result?.secret ?? null);
        setSecretDialogOpen(true);
      }
      setDialogOpen(false);
      await loadEnvs();
    } catch (err) {
      console.error("Failed to save environment:", err);
      toast.error("操作失败: " + (err as Error).message);
    } finally {
      setFormSaving(false);
    }
  }, [editingEnv, formName, formDescription, formWorkspacePath, formAgentConfigId, formAutoStart, loadEnvs]);

  const handleEnterAgent = useCallback(
    async (env: Environment) => {
      if (!onNavigateToSession) return;
      setEnteringEnvId(env.id);
      try {
        const { data, error: err } = await client.web.environments({ id: env.id }).enter.post({});
        if (err) throw new Error(err.message ?? "进入失败");
        const result = data as { session_id: string; environment_id: string } | null;
        await new Promise((r) => setTimeout(r, 500));
        onNavigateToSession(result?.session_id ?? "", {
          cwd: env.workspace_path,
          agentId: result?.environment_id ?? env.id,
        });
      } catch (err) {
        console.error("进入智能体失败", err);
        toast.error("进入智能体失败: " + (err as Error).message);
      } finally {
        setEnteringEnvId(null);
      }
    },
    [onNavigateToSession],
  );

  const handleEnterInstance = useCallback(
    async (env: Environment, instanceNumber: number) => {
      if (!onNavigateToSession) return;
      setEnteringEnvId(env.id);
      try {
        const { data, error: err } = await client.web.environments({ id: env.id }).enter.post({
          instance_number: instanceNumber,
        });
        if (err) throw new Error(err.message ?? "进入失败");
        const result = data as { session_id: string; environment_id: string } | null;
        await new Promise((r) => setTimeout(r, 500));
        onNavigateToSession(result?.session_id ?? "", {
          cwd: env.workspace_path,
          agentId: result?.environment_id ?? env.id,
        });
      } catch (err) {
        console.error("进入实例失败", err);
        toast.error("进入实例失败: " + (err as Error).message);
      } finally {
        setEnteringEnvId(null);
      }
    },
    [onNavigateToSession],
  );

  const handleSpawnNewInstance = useCallback(
    async (env: Environment) => {
      if (!onNavigateToSession) return;
      setEnteringEnvId(env.id);
      try {
        const { data, error: err } = await client.web.instances.post({ environmentId: env.id });
        if (err) throw new Error(err.message ?? "创建实例失败");
        const spawnResult = data as { session_id?: string; environment_id?: string } | null;
        await new Promise((r) => setTimeout(r, 500));
        onNavigateToSession(spawnResult?.session_id ?? "", {
          cwd: env.workspace_path,
          agentId: spawnResult?.environment_id ?? env.id,
        });
        await loadEnvs();
      } catch (err) {
        console.error("创建实例失败", err);
        toast.error("创建实例失败: " + (err as Error).message);
      } finally {
        setEnteringEnvId(null);
      }
    },
    [onNavigateToSession, loadEnvs],
  );

  const confirmStopInstance = useCallback(async () => {
    if (!stopTarget) return;
    try {
      const { error: err } = await client.web.instances({ id: stopTarget.instanceId }).delete();
      if (err) throw new Error(err.message ?? "停止失败");
      await new Promise((r) => setTimeout(r, 500));
      await loadEnvs();
    } catch (err) {
      console.error("停止实例失败", err);
      toast.error("停止实例失败: " + (err as Error).message);
    } finally {
      setStopConfirmOpen(false);
      setStopTarget(null);
    }
  }, [stopTarget, loadEnvs]);

  const handleRefresh = useCallback(
    async (env: Environment) => {
      const instances = instancesMap[env.id] ?? [];
      const active = instances.find((i) => i.status === "running" || i.status === "starting");
      const instanceId = active?.id ?? env.instance_id;
      if (!instanceId) return;
      setRefreshingEnvId(env.id);
      try {
        await client.web.instances({ id: instanceId }).delete();
        await new Promise((r) => setTimeout(r, 500));
        await handleEnterAgent(env);
      } catch (err) {
        console.error("刷新智能体失败", err);
        toast.error("刷新智能体失败: " + (err as Error).message);
      } finally {
        setRefreshingEnvId(null);
      }
    },
    [instancesMap, handleEnterAgent],
  );

  const handleViewSecret = useCallback(async (id: string) => {
    try {
      const { data, error: err } = await client.web.environments({ id }).get();
      if (err) {
        console.error("Failed to get secret:", err);
        return;
      }
      const detail = data as { secret?: string } | null;
      setCurrentSecret(detail?.secret ?? null);
      setSecretDialogOpen(true);
    } catch (err) {
      console.error("Failed to get secret:", err);
    }
  }, []);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      const { error: err } = await client.web.environments({ id: deleteTarget }).delete();
      if (err) {
        console.error("Failed to delete:", err);
        return;
      }
      setDeleteTarget(null);
      setConfirmOpen(false);
      await loadEnvs();
    } catch (err) {
      console.error("Failed to delete environment:", err);
    }
  }, [deleteTarget, loadEnvs]);

  if (loading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <div className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" />
        <p className="text-sm text-text-muted">加载智能体列表...</p>
      </div>
    );
  }

  const isOnline = (env: Environment) => env.instance_status === "running" || env.instance_status === "starting";

  /** Map environment status to card display status */
  type CardStatus = "running" | "idle" | "warning" | "error";

  const getCardStatus = (env: Environment): CardStatus => {
    if (env.instance_status === "error") return "error";
    if (env.instance_status === "running" || env.instance_status === "starting") return "running";
    if (env.instance_status === "idle") return "idle";
    // If has instances but status is ambiguous, show warning
    if (env.instance_id && env.instance_status !== "running" && env.instance_status !== "starting") return "warning";
    // Offline / no instance
    return "idle";
  };

  const STATUS_STYLES: Record<
    CardStatus,
    {
      iconBg: string;
      pill: string;
      bar: string;
      label: string;
    }
  > = {
    running: {
      iconBg: "bg-emerald-500/12 text-emerald-600",
      pill: "bg-emerald-500/12 text-emerald-600",
      bar: "bg-emerald-500",
      label: "运行中",
    },
    idle: {
      iconBg: "bg-indigo-500/10 text-indigo-500",
      pill: "bg-indigo-500/10 text-indigo-500",
      bar: "bg-indigo-500",
      label: "空闲",
    },
    warning: {
      iconBg: "bg-amber-500/12 text-amber-600",
      pill: "bg-amber-500/12 text-amber-600",
      bar: "bg-amber-500",
      label: "警告",
    },
    error: {
      iconBg: "bg-red-500/12 text-red-600",
      pill: "bg-red-500/12 text-red-600",
      bar: "bg-red-500",
      label: "错误",
    },
  };

  /** Format a seconds-level timestamp to relative time string */
  const formatRelativeTime = (ts: number | null | undefined): string => {
    if (!ts) return "未活跃";
    const diff = Date.now() - ts * 1000;
    const seconds = Math.floor(diff / 1000);
    if (seconds < 0) return "刚刚活跃";
    if (seconds < 60) return `${seconds} 秒前活跃`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} 分钟前活跃`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时前活跃`;
    const days = Math.floor(hours / 24);
    return `${days} 天前活跃`;
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-6">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-lg font-semibold text-text-primary">智能体</h1>
          <div className="flex items-center gap-3">
            {/* Tab Switch */}
            <div className="flex gap-1 rounded-lg bg-surface-2 p-1">
              <button
                type="button"
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  envTab === "environments"
                    ? "bg-surface-1 text-text-primary shadow-sm"
                    : "text-text-muted hover:text-text-secondary"
                }`}
                onClick={() => setEnvTab("environments")}
              >
                智能体
              </button>
              <button
                type="button"
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  envTab === "subagents"
                    ? "bg-surface-1 text-text-primary shadow-sm"
                    : "text-text-muted hover:text-text-secondary"
                }`}
                onClick={() => setEnvTab("subagents")}
              >
                智能体模板
              </button>
            </div>
            {/* View Toggle */}
            {envTab === "environments" && (
              <div className="flex gap-0.5 rounded-lg border border-border-subtle bg-surface-0 p-0.5">
                <button
                  type="button"
                  className={`flex items-center justify-center rounded-md px-2 py-1 text-xs font-medium transition-all ${
                    viewMode === "table"
                      ? "bg-surface-1 text-text-bright shadow-xs"
                      : "text-text-dim hover:text-text-primary"
                  }`}
                  onClick={() => setViewMode("table")}
                  title="列表视图"
                >
                  <List className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  className={`flex items-center justify-center rounded-md px-2 py-1 text-xs font-medium transition-all ${
                    viewMode === "card"
                      ? "bg-surface-1 text-text-bright shadow-xs"
                      : "text-text-dim hover:text-text-primary"
                  }`}
                  onClick={() => setViewMode("card")}
                  title="卡片视图"
                >
                  <LayoutGrid className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
            {envTab === "environments" && (
              <Button onClick={openCreateDialog} size="sm">
                <Plus className="mr-1 h-4 w-4" />
                创建智能体
              </Button>
            )}
          </div>
        </div>

        {envTab === "subagents" ? (
          <AgentsPage />
        ) : envs.length === 0 ? (
          <button
            type="button"
            onClick={openCreateDialog}
            className="flex w-full flex-col items-center justify-center rounded-xl border-2 border-dashed border-border bg-surface-1/50 px-6 py-16 text-text-muted transition-colors hover:border-brand/40 hover:bg-brand/5 cursor-pointer"
          >
            <Bot className="mb-3 h-10 w-10 opacity-40" />
            <span className="text-sm font-medium">创建第一个智能体</span>
            <span className="mt-1 text-xs opacity-60">配置工作目录和 Agent 类型，即可开始对话</span>
          </button>
        ) : viewMode === "table" ? (
          /* ===== TABLE VIEW ===== */
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {envs.map((env) => {
              const online = isOnline(env);
              const entering = enteringEnvId === env.id;
              return (
                <div
                  key={env.id}
                  className="group flex flex-col rounded-xl border border-border bg-surface-1 p-4 transition-shadow hover:shadow-md"
                >
                  {/* Header: name + status dot */}
                  <div className="mb-3 flex items-start justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className={`inline-block h-2 w-2 rounded-full shrink-0 ${online ? "bg-green-500" : "bg-gray-400"}`}
                      />
                      <span className="truncate text-sm font-medium text-text-primary">{env.name}</span>
                      {env.auto_start && (
                        <span className="rounded bg-brand/10 px-1 py-0.5 text-[10px] font-medium text-brand">自启</span>
                      )}
                      {env.instances_count !== undefined && env.instances_count > 1 && (
                        <span className="rounded bg-emerald-500/10 px-1 py-0.5 text-[10px] font-medium text-emerald-600">
                          实例 x{env.instances_count}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0"
                        onClick={() => openEditDialog(env)}
                        title="编辑"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0"
                        onClick={() => handleViewSecret(env.id)}
                        title="查看 Secret"
                      >
                        <svg
                          className="h-3.5 w-3.5"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                        </svg>
                      </Button>
                      {env.instance_id && online && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-brand hover:text-brand/80"
                          disabled={refreshingEnvId === env.id}
                          onClick={() => handleRefresh(env)}
                          title="重启实例"
                        >
                          <RotateCw className={`h-3.5 w-3.5 ${refreshingEnvId === env.id ? "animate-spin" : ""}`} />
                        </Button>
                      )}
                      {env.instance_id && online && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-red-500 hover:text-red-600"
                          onClick={() => {
                            const instances = instancesMap[env.id] ?? [];
                            const active = instances.find((i) => i.status === "running" || i.status === "starting");
                            const targetId = active ? active.id : env.instance_id!;
                            setStopTarget({
                              instanceId: targetId,
                              envName: env.name,
                            });
                            setStopConfirmOpen(true);
                          }}
                          title="停止实例"
                        >
                          <Power className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-red-500 hover:text-red-600"
                        onClick={() => {
                          setDeleteTarget(env.id);
                          setConfirmOpen(true);
                        }}
                        title="删除"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>

                  {/* Info */}
                  <div className="mb-4 flex-1 space-y-1">
                    <div className="flex items-center gap-1.5 text-xs text-text-muted">
                      <svg
                        className="h-3 w-3 shrink-0"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                      </svg>
                      <span className="truncate">{env.workspace_path}</span>
                    </div>
                    {env.agent_name && (
                      <div className="flex items-center gap-1.5 text-xs text-text-muted">
                        <Bot className="h-3 w-3 shrink-0" />
                        <span>{env.agent_name}</span>
                      </div>
                    )}
                    {env.description && <p className="text-xs text-text-muted line-clamp-2">{env.description}</p>}
                  </div>

                  {/* Enter button — Split Button for multi-instance */}
                  {(() => {
                    const instances = instancesMap[env.id] ?? [];
                    const activeInstances = instances.filter((i) => i.status === "running" || i.status === "starting");

                    if (!online) {
                      return (
                        <Button className="w-full" size="sm" disabled={entering} onClick={() => handleEnterAgent(env)}>
                          {entering ? (
                            <>
                              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                              启动中...
                            </>
                          ) : (
                            "启动并进入"
                          )}
                        </Button>
                      );
                    }

                    return (
                      <div className="flex w-full">
                        <Button
                          className="flex-1 rounded-r-none"
                          size="sm"
                          disabled={entering}
                          onClick={() => handleEnterAgent(env)}
                        >
                          {entering ? (
                            <>
                              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                              启动中...
                            </>
                          ) : (
                            "进入对话"
                          )}
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button className="rounded-l-none border-l-0 px-2" size="sm" disabled={entering}>
                              <ChevronDown className="h-3.5 w-3.5" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-48">
                            {activeInstances.map((inst) => (
                              <DropdownMenuItem
                                key={inst.id}
                                onClick={() => handleEnterInstance(env, inst.instance_number)}
                              >
                                <span
                                  className={`inline-block h-2 w-2 rounded-full mr-2 ${inst.status === "running" ? "bg-green-500" : "bg-yellow-500"}`}
                                />
                                <span>实例 {inst.instance_number}</span>
                                <span className="ml-auto text-xs text-muted-foreground">{inst.status}</span>
                              </DropdownMenuItem>
                            ))}
                            {activeInstances.length > 0 && <DropdownMenuSeparator />}
                            <DropdownMenuItem onClick={() => handleSpawnNewInstance(env)}>
                              <Plus className="h-3.5 w-3.5 mr-1" />
                              <span>新建实例</span>
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    );
                  })()}
                </div>
              );
            })}
          </div>
        ) : (
          /* ===== CARD VIEW ===== */
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
            {envs.map((env) => {
              const status = getCardStatus(env);
              const statusColors = STATUS_STYLES[status];
              const instances = instancesMap[env.id] ?? [];
              const instanceCount = env.instances_count ?? instances.length;
              const entering = enteringEnvId === env.id;
              const online = isOnline(env);

              return (
                <div
                  key={env.id}
                  className="group relative flex flex-col overflow-hidden rounded-xl border border-border-subtle bg-surface-1 transition-all duration-200 hover:border-border-default hover:shadow-elevated hover:-translate-y-0.5"
                >
                  {/* Left accent bar */}
                  <div className={`absolute left-0 top-0 bottom-0 w-0.75 rounded-l-xl ${statusColors.bar}`} />

                  {/* Top: icon + name/model + status pill */}
                  <div className="flex items-center justify-between p-4 pb-0 pl-5">
                    <div className="flex items-center gap-3 min-w-0">
                      <div
                        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] ${statusColors.iconBg}`}
                      >
                        <Bot className="h-5 w-5" />
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-text-bright">{env.name}</div>
                        <div className="truncate font-mono text-[11px] text-text-dim">
                          {env.agent_name || env.workspace_path.split("/").pop() || "--"}
                        </div>
                      </div>
                    </div>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${statusColors.pill}`}>
                      {statusColors.label}
                    </span>
                  </div>

                  {/* Body: 2-col stats grid */}
                  <div className="px-4 pt-3 pb-2 pl-5">
                    <div className="grid grid-cols-2 gap-2">
                      <div className="rounded-lg bg-surface-0 p-2 text-center">
                        <div className="font-mono text-base font-bold text-text-bright">{instanceCount}</div>
                        <div className="mt-0.5 text-[10px] uppercase tracking-wide text-text-dim">会话</div>
                      </div>
                      <div className="rounded-lg bg-surface-0 p-2 text-center">
                        <div className="font-mono text-base font-bold text-text-bright">
                          {online ? (env.instances_count ?? 1) : 0}
                        </div>
                        <div className="mt-0.5 text-[10px] uppercase tracking-wide text-text-dim">实例</div>
                      </div>
                    </div>
                    {/* Description */}
                    {env.description && (
                      <p className="mt-2 line-clamp-2 text-[11px] text-text-dim">{env.description}</p>
                    )}
                  </div>

                  {/* Footer: time + action buttons */}
                  <div className="mt-auto flex items-center justify-between border-t border-border-subtle px-4 py-2.5 pl-5">
                    <span className="text-[11px] text-text-dim">{formatRelativeTime(env.updated_at)}</span>
                    <div className="flex items-center gap-1">
                      {/* Hover actions */}
                      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity mr-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0"
                          onClick={() => openEditDialog(env)}
                          title="编辑"
                        >
                          <Pencil className="h-3 w-3" />
                        </Button>
                        {status === "error" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0 text-red-500 hover:text-red-600"
                            disabled={refreshingEnvId === env.id}
                            onClick={() => handleRefresh(env)}
                            title="重试"
                          >
                            <RefreshCw className={`h-3 w-3 ${refreshingEnvId === env.id ? "animate-spin" : ""}`} />
                          </Button>
                        )}
                      </div>

                      {/* Primary action */}
                      {entering ? (
                        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" disabled>
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0"
                          onClick={() => handleEnterAgent(env)}
                          title={online ? "进入对话" : "启动并进入"}
                        >
                          <ArrowRight className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Create/Edit Form Dialog */}
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editingEnv ? "编辑智能体" : "创建智能体"}</DialogTitle>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="name">名称</Label>
                <Input
                  id="name"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="my-agent (kebab-case)"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="description">描述</Label>
                <Input
                  id="description"
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                  placeholder="可选"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="workspacePath">Workspace 路径</Label>
                <Input
                  id="workspacePath"
                  value={formWorkspacePath}
                  onChange={(e) => setFormWorkspacePath(e.target.value)}
                  placeholder="/home/user/project"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="agentName">关联 Agent</Label>
                <Select value={formAgentConfigId} onValueChange={setFormAgentConfigId}>
                  <SelectTrigger>
                    <SelectValue placeholder="选择 Agent（可选）" />
                  </SelectTrigger>
                  <SelectContent>
                    {agentOptions.map((opt) => (
                      <SelectItem key={opt.id} value={opt.id}>
                        {opt.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <button
                type="button"
                className="flex items-center gap-2 text-left"
                onClick={() => setFormAutoStart(!formAutoStart)}
              >
                <span
                  className={`inline-flex h-4 w-4 items-center justify-center rounded border ${formAutoStart ? "bg-brand border-brand" : "border-border bg-transparent"}`}
                >
                  {formAutoStart && (
                    <svg
                      className="h-3 w-3 text-white"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </span>
                <span className="text-sm text-text-primary cursor-pointer">服务器启动时自动运行</span>
              </button>
            </div>
            {formError && <p className="text-sm text-status-error px-1">{formError}</p>}
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>
                取消
              </Button>
              <Button onClick={handleFormSubmit} disabled={formSaving}>
                {formSaving ? "保存中..." : editingEnv ? "更新" : "创建"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Secret Display Dialog */}
        <Dialog open={secretDialogOpen} onOpenChange={setSecretDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>智能体 Secret</DialogTitle>
            </DialogHeader>
            <div className="py-4">
              <p className="mb-2 text-sm text-amber-600 font-medium">请立即保存此 Secret，关闭后将无法再次查看</p>
              <div className="flex items-center gap-2 rounded-md bg-gray-100 p-3 font-mono text-sm break-all dark:bg-gray-800">
                <span className="flex-1">{currentSecret}</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (currentSecret) {
                      navigator.clipboard.writeText(currentSecret);
                      setSecretCopied(true);
                      setTimeout(() => setSecretCopied(false), 2000);
                    }
                  }}
                  className={secretCopied ? "border-status-active/30 text-status-active" : ""}
                >
                  {secretCopied ? "已复制!" : "复制"}
                </Button>
              </div>
            </div>
            <DialogFooter>
              <Button onClick={() => setSecretDialogOpen(false)}>关闭</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Delete Confirm Dialog */}
        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title="确认删除"
          description="确定要删除此智能体吗？此操作不可撤销。"
          onConfirm={handleDelete}
        />

        {/* Stop Instance Confirm Dialog */}
        <ConfirmDialog
          open={stopConfirmOpen}
          onOpenChange={(open) => {
            setStopConfirmOpen(open);
            if (!open) setStopTarget(null);
          }}
          title="确认停止实例"
          description={`确定要停止智能体「${stopTarget?.envName ?? ""}」的运行实例吗？正在进行的对话将被中断。`}
          variant="destructive"
          onConfirm={confirmStopInstance}
        />
      </div>
    </div>
  );
}
