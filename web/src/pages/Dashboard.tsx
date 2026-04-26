import { useState, useEffect, useCallback } from "react";
import { apiFetchEnvironments, apiGetEnvironment, apiCreateEnvironment, apiUpdateEnvironment, apiDeleteEnvironment, apiListAgents, apiSpawnInstanceFromEnvironment, apiListInstances, apiDeleteInstance, type InstanceInfo } from "../api/client";
import type { Environment } from "../types";
import { DataTable, type Column } from "@/components/config/DataTable";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import type { ExpandedState } from "@tanstack/react-table";

interface DashboardProps {
  onNavigateToSession?: (sessionId: string) => void;
}

export function Dashboard({ onNavigateToSession }: DashboardProps) {
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
  const [secretDialogOpen, setSecretDialogOpen] = useState(false);
  const [currentSecret, setCurrentSecret] = useState<string | null>(null);
  const [agentOptions, setAgentOptions] = useState<string[]>([]);
  const [instances, setInstances] = useState<InstanceInfo[]>([]);
  const [expandedRows, setExpandedRows] = useState<ExpandedState>({});

  const loadEnvs = useCallback(async () => {
    try {
      const data = await apiFetchEnvironments();
      setEnvs(data || []);
    } catch (err) {
      console.error("Failed to load environments:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadEnvs();
    apiListInstances().then(setInstances).catch(() => {});
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
    setDialogOpen(true);
  }, []);

  const openEditDialog = useCallback((env: Environment) => {
    setEditingEnv(env);
    setFormName(env.name);
    setFormDescription(env.description || "");
    setFormWorkspacePath(env.workspace_path);
    setFormAgentName(env.agent_name || "");
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
        });
      } else {
        const result = await apiCreateEnvironment({
          name: formName,
          description: formDescription || undefined,
          workspacePath: formWorkspacePath,
          agentName: formAgentName || undefined,
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
  }, [editingEnv, formName, formDescription, formWorkspacePath, formAgentName, loadEnvs]);

  const handleSpawnInstance = useCallback(async (envId: string) => {
    try {
      await apiSpawnInstanceFromEnvironment(envId);
      const insts = await apiListInstances();
      setInstances(insts);
      setExpandedRows((prev) => ({ ...prev, [envId]: true }));
      await loadEnvs();
    } catch (err) {
      alert((err as Error).message);
    }
  }, [loadEnvs]);

  const handleStopInstance = useCallback(async (instId: string) => {
    try {
      await apiDeleteInstance(instId);
      setInstances((prev) => prev.filter((i) => i.id !== instId));
    } catch (err) {
      alert((err as Error).message);
    }
  }, []);

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

  const columns: Column<Environment>[] = [
    { key: "name", header: "名称", sortable: true, filterable: true },
    { key: "workspace_path", header: "Workspace", sortable: true, filterable: true },
    { key: "agent_name", header: "关联Agent", sortable: true },
    {
      key: "status",
      header: "状态",
      filterable: true,
      render: (row) => {
        const colorMap: Record<string, string> = { active: "bg-green-100 text-green-700", idle: "bg-gray-100 text-gray-700", error: "bg-red-100 text-red-700" };
        return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${colorMap[row.status] || "bg-gray-100 text-gray-700"}`}>{row.status}</span>;
      },
    },
    {
      key: "last_poll_at",
      header: "最后活跃",
      sortable: true,
      render: (row) => row.last_poll_at ? new Date(row.last_poll_at * 1000).toLocaleString() : "—",
    },
  ];

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-text-muted">加载中...</div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-6">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-lg font-semibold text-text-primary">环境管理</h1>
          <Button onClick={openCreateDialog} size="sm">
            + 注册环境
          </Button>
        </div>

        <DataTable
          data={envs}
          columns={columns}
          keyField="id"
          rowKey={(row) => row.id}
          expandedState={expandedRows}
          onExpandedChange={setExpandedRows}
          expandableRow={(env) => {
            const envInstances = instances.filter((i) => i.environment_id === env.id);
            if (envInstances.length === 0) {
              return <div className="text-sm text-muted-foreground py-1">暂无运行实例</div>;
            }
            return (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="pb-1 font-medium">实例 ID</th>
                    <th className="pb-1 font-medium">端口</th>
                    <th className="pb-1 font-medium">状态</th>
                    <th className="pb-1 font-medium">创建时间</th>
                    <th className="pb-1 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {envInstances.map((inst) => (
                    <tr key={inst.id} className="border-t">
                      <td className="py-1.5 font-mono text-xs">{inst.id}</td>
                      <td className="py-1.5">{inst.port}</td>
                      <td className="py-1.5">
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                          inst.status === "running" ? "bg-green-100 text-green-700"
                          : inst.status === "error" ? "bg-red-100 text-red-700"
                          : "bg-gray-100 text-gray-700"
                        }`}>{inst.status}</span>
                      </td>
                      <td className="py-1.5">{new Date(inst.created_at * 1000).toLocaleString()}</td>
                      <td className="py-1.5">
                        <div className="flex gap-1">
                          {onNavigateToSession && inst.session_id && (
                            <Button variant="outline" size="sm" onClick={() => onNavigateToSession(inst.session_id!)}>
                              进入对话
                            </Button>
                          )}
                          {inst.status !== "stopped" && (
                            <Button variant="outline" size="sm" className="text-red-600" onClick={() => handleStopInstance(inst.id)}>
                              停止
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            );
          }}
          actions={(row) => (
            <div className="flex gap-1">
              <Button variant="outline" size="sm" onClick={() => handleSpawnInstance(row.id)}>
                启动实例
              </Button>
              <Button variant="outline" size="sm" onClick={() => handleViewSecret(row.id)}>
                查看 Secret
              </Button>
              <Button variant="outline" size="sm" onClick={() => openEditDialog(row)}>
                编辑
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-red-600 hover:text-red-700"
                onClick={() => {
                  setDeleteTarget(row.id);
                  setConfirmOpen(true);
                }}
              >
                删除
              </Button>
            </div>
          )}
        />

        {/* Create/Edit Form Dialog */}
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editingEnv ? "编辑环境" : "注册新环境"}</DialogTitle>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="name">名称</Label>
                <Input id="name" value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="my-env (kebab-case)" />
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
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>取消</Button>
              <Button onClick={handleFormSubmit} disabled={formSaving}>
                {formSaving ? "保存中..." : editingEnv ? "更新" : "注册"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Secret Display Dialog */}
        <Dialog open={secretDialogOpen} onOpenChange={setSecretDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>环境 Secret</DialogTitle>
            </DialogHeader>
            <div className="py-4">
              <p className="mb-2 text-sm text-text-muted">请立即保存此 Secret，之后将无法再通过列表查看</p>
              <div className="flex items-center gap-2 rounded-md bg-gray-100 p-3 font-mono text-sm break-all">
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
          description="确定要删除此环境吗？此操作不可撤销。"
          onConfirm={handleDelete}
        />
      </div>
    </div>
  );
}
