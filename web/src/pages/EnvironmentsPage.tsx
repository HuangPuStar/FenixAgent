import { useState, useEffect, useCallback } from "react";
import { apiFetchEnvironments, apiGetEnvironment, apiCreateEnvironment, apiUpdateEnvironment, apiDeleteEnvironment, apiListAgents, apiEnterEnvironment, apiDeleteInstance, apiListEnvironmentInstances, apiSpawnInstanceFromEnvironment } from "../api/client";
import type { Environment, EnvironmentInstance } from "../types";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Bot, Plus, Pencil, Trash2, Loader2, Power, ChevronDown, RotateCw, LayoutGrid, List, ArrowRight, RefreshCw } from "lucide-react";

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
  const [formAgentName, setFormAgentName] = useState("");
  const [formAutoStart, setFormAutoStart] = useState(false);
  const [secretDialogOpen, setSecretDialogOpen] = useState(false);
  const [currentSecret, setCurrentSecret] = useState<string | null>(null);
  const [agentOptions, setAgentOptions] = useState<string[]>([]);
  const [enteringEnvId, setEnteringEnvId] = useState<string | null>(null);
  const [instancesMap, setInstancesMap] = useState<Record<string, EnvironmentInstance[]>>({});
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false);
  const [stopTarget, setStopTarget] = useState<{ instanceId: string; envName: string } | null>(null);
  const [refreshingEnvId, setRefreshingEnvId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"table" | "card">("card");

  const loadEnvs = useCallback(async () => {
    try {
      const data = await apiFetchEnvironments();
      setEnvs(data || []);
      // Load instances for environments that have active instances
      const activeEnvs = (data || []).filter(e =>
        e.instances_count !== undefined && e.instances_count > 0
      );
      if (activeEnvs.length > 0) {
        const instanceEntries = await Promise.allSettled(
          activeEnvs.map(env => apiListEnvironmentInstances(env.id))
        );
        const newMap: Record<string, EnvironmentInstance[]> = {};
        activeEnvs.forEach((env, i) => {
          const result = instanceEntries[i];
          if (result.status === "fulfilled") {
            newMap[env.id] = result.value.instances;
          }
        });
        setInstancesMap(prev => ({ ...prev, ...newMap }));
      }
    } catch (err) {
      console.error("Failed to load environments:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadEnvs();
    apiListAgents()
      .then((data) => {
        setAgentOptions(data.agents.map((a) => a.name));
      })
      .catch(() => {});
  }, [loadEnvs]);

  const openCreateDialog = useCallback(() => {
    setEditingEnv(null);
    setFormName("");
    setFormDescription("");
    setFormWorkspacePath("");
    setFormAgentName("");
    setFormAutoStart(false);
    setDialogOpen(true);
  }, []);

  const openEditDialog = useCallback((env: Environment) => {
    setEditingEnv(env);
    setFormName(env.name);
    setFormDescription(env.description || "");
    setFormWorkspacePath(env.workspace_path);
    setFormAgentName(env.agent_name || "");
    setFormAutoStart(env.auto_start ?? false);
    setDialogOpen(true);
  }, []);

  const handleFormSubmit = useCallback(async () => {
    if (!formName || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(formName)) {
      alert("名称必须为 kebab-case 格式（小写字母、数字、连字符）");
      return;
    }
    if (!formWorkspacePath.startsWith("/")) {
      alert("workspace 路径必须是绝对路径");
      return;
    }

    setFormSaving(true);
    try {
      if (editingEnv) {
        await apiUpdateEnvironment(editingEnv.id, {
          name: formName,
          description: formDescription || undefined,
          workspacePath: formWorkspacePath,
          agentName: formAgentName || undefined,
          autoStart: formAutoStart,
        });
      } else {
        const result = await apiCreateEnvironment({
          name: formName,
          description: formDescription || undefined,
          workspacePath: formWorkspacePath,
          agentName: formAgentName || undefined,
          autoStart: formAutoStart,
        });
        setCurrentSecret(result.secret);
        setSecretDialogOpen(true);
      }
      setDialogOpen(false);
      await loadEnvs();
    } catch (err) {
      console.error("Failed to save environment:", err);
      alert((err as Error).message);
    } finally {
      setFormSaving(false);
    }
  }, [editingEnv, formName, formDescription, formWorkspacePath, formAgentName, formAutoStart, loadEnvs]);

  const handleEnterAgent = useCallback(async (env: Environment) => {
    if (!onNavigateToSession) return;
    setEnteringEnvId(env.id);
    try {
      const result = await apiEnterEnvironment(env.id);
      await new Promise((r) => setTimeout(r, 500));
      onNavigateToSession(result.session_id, { cwd: env.workspace_path });
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setEnteringEnvId(null);
    }
  }, [onNavigateToSession]);

  const handleEnterInstance = useCallback(async (env: Environment, instanceNumber: number) => {
    if (!onNavigateToSession) return;
    setEnteringEnvId(env.id);
    try {
      const result = await apiEnterEnvironment(env.id, instanceNumber);
      await new Promise((r) => setTimeout(r, 500));
      onNavigateToSession(result.session_id, { cwd: env.workspace_path });
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setEnteringEnvId(null);
    }
  }, [onNavigateToSession]);

  const handleSpawnNewInstance = useCallback(async (env: Environment) => {
    if (!onNavigateToSession) return;
    setEnteringEnvId(env.id);
    try {
      const spawnResult = await apiSpawnInstanceFromEnvironment(env.id);
      await new Promise((r) => setTimeout(r, 500));
      onNavigateToSession(spawnResult.session_id ?? "", { cwd: env.workspace_path });
      await loadEnvs();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setEnteringEnvId(null);
    }
  }, [onNavigateToSession, loadEnvs]);

  const handleStopInstance = useCallback(async (instanceId: string) => {
    try {
      await apiDeleteInstance(instanceId);
      await new Promise((r) => setTimeout(r, 500));
      await loadEnvs();
    } catch (err) {
      alert((err as Error).message);
    }
  }, [loadEnvs]);

  const confirmStopInstance = useCallback(async () => {
    if (!stopTarget) return;
    try {
      await apiDeleteInstance(stopTarget.instanceId);
      await new Promise((r) => setTimeout(r, 500));
      await loadEnvs();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setStopConfirmOpen(false);
      setStopTarget(null);
    }
  }, [stopTarget, loadEnvs]);

  const handleRefresh = useCallback(async (env: Environment) => {
    const instances = instancesMap[env.id] ?? [];
    const active = instances.find(i => i.status === "running" || i.status === "starting");
    const instanceId = active?.id ?? env.instance_id;
    if (!instanceId) return;
    setRefreshingEnvId(env.id);
    try {
      await apiDeleteInstance(instanceId);
      await new Promise((r) => setTimeout(r, 500));
      await handleEnterAgent(env);
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setRefreshingEnvId(null);
    }
  }, [instancesMap, handleEnterAgent]);

  const handleViewSecret = useCallback(async (id: string) => {
    try {
      const detail = await apiGetEnvironment(id);
      setCurrentSecret(detail.secret);
      setSecretDialogOpen(true);
    } catch (err) {
      console.error("Failed to get secret:", err);
    }
  }, []);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      await apiDeleteEnvironment(deleteTarget);
      setDeleteTarget(null);
      setConfirmOpen(false);
      await loadEnvs();
    } catch (err) {
      console.error("Failed to delete environment:", err);
    }
  }, [deleteTarget, loadEnvs]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-text-muted">加载中...</div>
      </div>
    );
  }

  const isOnline = (env: Environment) =>
    env.instance_status === "running" || env.instance_status === "starting";

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

  const STATUS_STYLES: Record<CardStatus, {
    iconBg: string;
    pill: string;
    bar: string;
    label: string;
  }> = {
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

  /** Format a timestamp to relative time string */
  const formatRelativeTime = (ts: number | null | undefined): string => {
    if (!ts) return "未活跃";
    const diff = Date.now() - ts;
    const seconds = Math.floor(diff / 1000);
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
            {/* View Toggle */}
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
            <Button onClick={openCreateDialog} size="sm">
              <Plus className="mr-1 h-4 w-4" />
              创建智能体
            </Button>
          </div>
        </div>

        {envs.length === 0 ? (
          <button
            type="button"
            onClick={openCreateDialog}
            className="flex w-full flex-col items-center justify-center rounded-xl border-2 border-dashed border-border bg-surface-1/50 px-6 py-16 text-text-muted transition-colors hover:border-brand/40 hover:bg-brand/5 cursor-pointer"
          >
            <Bot className="mb-3 h-10 w-10 opacity-40" />
            <span className="text-sm font-medium">创建第一个智能体</span>
            <span className="mt-1 text-xs opacity-60">配置工作目录和 Agent 类型，即可开始对话</span>
          </button>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {envs.map((env) => {
              const online = isOnline(env);
              const entering = enteringEnvId === env.id;
              return (
                <div
                  key={env.id}
                  className="group flex flex-col rounded-xl border border-border bg-surface-1 p-0 transition-all duration-200 hover:shadow-elevated hover:-translate-y-0.5 hover:border-border-default overflow-hidden"
                >
                  {/* Header: icon + name + status pill */}
                  <div className="flex items-start justify-between p-4 pb-0">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] ${online ? "bg-emerald-500/10 text-emerald-600" : "bg-brand/10 text-brand"}`}>
                        <Bot className="h-5 w-5" />
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-text-bright">{env.name}</div>
                        {env.agent_name && (
                          <div className="font-mono text-[11px] text-text-dim">{env.agent_name}</div>
                        )}
                      </div>
                    </div>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${online ? "bg-emerald-500/12 text-emerald-600" : "bg-gray-400/12 text-gray-500"}`}>
                      {online ? "运行中" : "离线"}
                    </span>
                  </div>

                  {/* Info + tags */}
                  <div className="px-4 pt-3 pb-2 flex-1 space-y-1">
                    {env.auto_start && (
                      <span className="mr-1 rounded bg-brand/10 px-1 py-0.5 text-[10px] font-medium text-brand">自启</span>
                    )}
                    {env.instances_count !== undefined && env.instances_count > 1 && (
                      <span className="mr-1 rounded bg-emerald-500/10 px-1 py-0.5 text-[10px] font-medium text-emerald-600">
                        实例 x{env.instances_count}
                      </span>
                    )}
                    <div className="flex items-center gap-1.5 text-xs text-text-muted">
                      <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                      <span className="truncate">{env.workspace_path}</span>
                    </div>
                    {env.description && (
                      <p className="text-xs text-text-muted line-clamp-2">{env.description}</p>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 px-4 pb-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => openEditDialog(env)} title="编辑">
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => handleViewSecret(env.id)} title="查看 Secret">
                      <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                    </Button>
                    {env.instance_id && online && (
                      <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-brand hover:text-brand/80" disabled={refreshingEnvId === env.id} onClick={() => handleRefresh(env)} title="重启实例">
                        <RotateCw className={`h-3.5 w-3.5 ${refreshingEnvId === env.id ? "animate-spin" : ""}`} />
                      </Button>
                    )}
                    {env.instance_id && online && (
                      <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-red-500 hover:text-red-600"
                        onClick={() => {
                          const instances = instancesMap[env.id] ?? [];
                          const active = instances.find(i => i.status === "running" || i.status === "starting");
                          const targetId = active ? active.id : env.instance_id!;
                          setStopTarget({ instanceId: targetId, envName: env.name });
                          setStopConfirmOpen(true);
                        }} title="停止实例">
                        <Power className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-red-500 hover:text-red-600"
                      onClick={() => { setDeleteTarget(env.id); setConfirmOpen(true); }} title="删除">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>

                  {/* Enter button — Split Button for multi-instance */}
                  {(() => {
                    const instances = instancesMap[env.id] ?? [];
                    const activeInstances = instances.filter(i => i.status === "running" || i.status === "starting");

                    if (!online) {
                      return (
                        <Button
                          className="w-full"
                          size="sm"
                          disabled={entering}
                          onClick={() => handleEnterAgent(env)}
                        >
                          {entering ? (
                            <>
                              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                              启动中...
                            </>
                          ) : "启动并进入"}
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
                          ) : "进入对话"}
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              className="rounded-l-none border-l-0 px-2"
                              size="sm"
                              disabled={entering}
                            >
                              <ChevronDown className="h-3.5 w-3.5" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-48">
                            {activeInstances.map((inst) => (
                              <DropdownMenuItem
                                key={inst.id}
                                onClick={() => handleEnterInstance(env, inst.instance_number)}
                              >
                                <span className={`inline-block h-2 w-2 rounded-full mr-2 ${
                                  inst.status === "running" ? "bg-green-500" : "bg-yellow-500"
                                }`} />
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
                <Input id="name" value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="my-agent (kebab-case)" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="description">描述</Label>
                <Input id="description" value={formDescription} onChange={(e) => setFormDescription(e.target.value)} placeholder="可选" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="workspacePath">Workspace 路径</Label>
                <Input id="workspacePath" value={formWorkspacePath} onChange={(e) => setFormWorkspacePath(e.target.value)} placeholder="/home/user/project" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="agentName">关联 Agent</Label>
                <Select value={formAgentName} onValueChange={setFormAgentName}>
                  <SelectTrigger>
                    <SelectValue placeholder="选择 Agent（可选）" />
                  </SelectTrigger>
                  <SelectContent>
                    {agentOptions.map((name) => (
                      <SelectItem key={name} value={name}>{name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <button
                type="button"
                className="flex items-center gap-2 text-left"
                onClick={() => setFormAutoStart(!formAutoStart)}
              >
                <span className={`inline-flex h-4 w-4 items-center justify-center rounded border ${formAutoStart ? "bg-brand border-brand" : "border-border bg-transparent"}`}>
                  {formAutoStart && (
                    <svg className="h-3 w-3 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                  )}
                </span>
                <span className="text-sm text-text-primary cursor-pointer">服务器启动时自动运行</span>
              </button>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>取消</Button>
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
              <p className="mb-2 text-sm text-text-muted">请立即保存此 Secret，之后将无法再通过列表查看</p>
              <div className="flex items-center gap-2 rounded-md bg-gray-100 p-3 font-mono text-sm break-all dark:bg-gray-800">
                <span className="flex-1">{currentSecret}</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (currentSecret) navigator.clipboard.writeText(currentSecret);
                  }}
                >
                  复制
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
          onOpenChange={(open) => { setStopConfirmOpen(open); if (!open) setStopTarget(null); }}
          title="确认停止实例"
          description={`确定要停止智能体「${stopTarget?.envName ?? ""}」的运行实例吗？正在进行的对话将被中断。`}
          variant="destructive"
          onConfirm={confirmStopInstance}
        />
      </div>
    </div>
  );
}
