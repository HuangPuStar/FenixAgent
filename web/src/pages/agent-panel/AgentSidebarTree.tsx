import { Bot, Loader2, Plus, RotateCw, Settings, Square, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import type { NodeState, TreeNodeData } from "@/components/ui/tree";
import { Tree } from "@/components/ui/tree";
import { agentApi, envApi, instanceApi } from "@/src/api/sdk";
import { useOrg } from "../../contexts/OrgContext";
import { NS } from "../../i18n";
import { useConfigChangeListener } from "../../lib/config-events";
import type { Environment, EnvironmentInstance } from "../../types/index";

interface AgentConfigItem {
  id: string;
  name: string;
  builtIn: boolean;
  model: string | null;
  description: string | null;
  color: string | null;
}

interface AgentExtra {
  agent: AgentConfigItem;
  environmentId: string | null;
}

interface InstanceExtra {
  agentId: string;
  environmentId: string;
  instanceNumber: number;
  status: string;
  instanceId: string;
}

interface AgentSidebarTreeProps {
  selectedInstanceId: string | null;
  onSelectInstance: (instanceId: string, envId: string, sessionId: string | null) => void;
  onCreateAgent?: () => void;
  onEditAgent?: (agentName: string) => void;
}

export function AgentSidebarTree({
  selectedInstanceId,
  onSelectInstance,
  onCreateAgent,
  onEditAgent,
}: AgentSidebarTreeProps) {
  const { t } = useTranslation(NS.AGENT_PANEL);
  const { org } = useOrg();
  const orgId = org?.id;

  const agentExtrasRef = useRef<Map<string, AgentExtra>>(new Map());
  const instanceExtrasRef = useRef<Map<string, InstanceExtra>>(new Map());
  const [loading, setLoading] = useState(true);
  const [enteringAgentId, setEnteringAgentId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [restartingIds, setRestartingIds] = useState<Set<string>>(new Set());
  const [stoppingIds, setStoppingIds] = useState<Set<string>>(new Set());

  // 多实例重启弹窗
  const [restartDialogOpen, setRestartDialogOpen] = useState(false);
  const [restartTargetAgentId, setRestartTargetAgentId] = useState<string | null>(null);
  const [selectedRestartInstances, setSelectedRestartInstances] = useState<Set<string>>(new Set());

  // 删除智能体弹窗
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteTargetAgentId, setDeleteTargetAgentId] = useState<string | null>(null);

  const getInstanceStatus = useCallback((status: string) => {
    if (status === "running") return "running";
    if (status === "starting") return "starting";
    if (status === "error") return "error";
    return "stopped";
  }, []);

  // 加载根级 agents
  const loadAgents = useCallback(async () => {
    const [{ data: agentsResult }, { data: envsData }] = await Promise.all([agentApi.list(), envApi.list()]);
    const rawAgents = (agentsResult as unknown as { agents?: AgentConfigItem[] } | null)?.agents;
    const agents = Array.isArray(rawAgents) ? rawAgents : [];
    const envs = Array.isArray(envsData) ? (envsData as Environment[]) : [];

    const userAgents = agents.filter((a) => !a.builtIn);

    const envByConfigId = new Map<string, Environment>();
    for (const env of envs) {
      if (env.agent_config_id) {
        envByConfigId.set(env.agent_config_id, env);
      }
    }

    const extras = new Map<string, AgentExtra>();
    for (const agent of userAgents) {
      const env = envByConfigId.get(agent.id);
      extras.set(agent.id, { agent, environmentId: env?.id ?? null });
    }
    agentExtrasRef.current = extras;

    return userAgents.map((agent) => {
      const env = envByConfigId.get(agent.id);
      const hasInstances = (env?.instances_count ?? 0) > 0;
      return {
        id: agent.id,
        label: agent.name,
        icon: Bot,
        hasChildren: hasInstances || env !== undefined,
        badge: hasInstances ? env!.instances_count : undefined,
      } satisfies TreeNodeData;
    });
  }, []);

  // 加载指定 agent 的 instances
  const loadInstances = useCallback(
    async (agentId: string) => {
      const extra = agentExtrasRef.current.get(agentId);
      if (!extra?.environmentId) return [];

      const { data: instData } = await envApi.listInstances({ id: extra.environmentId });
      const instances = (instData as { instances?: EnvironmentInstance[] } | null)?.instances ?? [];

      for (const inst of instances) {
        instanceExtrasRef.current.set(inst.id, {
          agentId,
          environmentId: extra.environmentId,
          instanceNumber: inst.instance_number,
          status: inst.status,
          instanceId: inst.id,
        });
      }

      return instances.map((inst) => ({
        id: inst.id,
        label: t("instanceN", { number: inst.instance_number }),
        hasChildren: false,
      })) satisfies TreeNodeData[];
    },
    [t],
  );

  const getChildren = useCallback(
    async (parentId: string | null): Promise<TreeNodeData[]> => {
      try {
        if (parentId === null) {
          const agents = await loadAgents();
          setLoading(false);
          return agents;
        }
        if (agentExtrasRef.current.has(parentId)) {
          return loadInstances(parentId);
        }
        return [];
      } catch (err) {
        console.error("[AgentSidebarTree] Failed to load children:", err);
        if (parentId === null) setLoading(false);
        return [];
      }
    },
    [loadAgents, loadInstances],
  );

  // 进入智能体
  const handleEnterAgent = useCallback(
    async (agentId: string, opts?: { instanceId?: string; spawnNew?: boolean }) => {
      const extra = agentExtrasRef.current.get(agentId);
      if (!extra) return;
      const { agent, environmentId: existingEnvId } = extra;
      setEnteringAgentId(agent.id);
      try {
        let envId = existingEnvId;

        if (!envId) {
          const { data: newEnv } = await envApi.create({
            name: agent.name,
            agentConfigId: agent.id,
            autoStart: true,
          });
          envId = (newEnv as unknown as Environment | null)?.id ?? null;
          if (!envId) {
            toast.error(t("enterInstanceFailed", { message: "Failed to create environment" }));
            return;
          }
          agentExtrasRef.current.set(agentId, { ...extra, environmentId: envId });
          setRefreshKey((k) => k + 1);
        }

        if (opts?.spawnNew) {
          const { data: spawnResult } = await instanceApi.spawn({ environmentId: envId });
          const spawned = spawnResult as { instance_number?: number } | null;
          const newInstanceNumber = spawned?.instance_number;
          if (newInstanceNumber !== undefined) {
            const { data: result } = await envApi.enter({ id: envId }, { instance_number: newInstanceNumber });
            const enterResult = result as {
              session_id?: string;
              instance_id?: string;
              environment_id?: string;
            } | null;
            onSelectInstance(
              enterResult?.instance_id ?? "",
              enterResult?.environment_id ?? envId,
              enterResult?.session_id ?? null,
            );
          }
        } else if (opts?.instanceId) {
          const instExtra = instanceExtrasRef.current.get(opts.instanceId);
          const instanceNumber = instExtra?.instanceNumber;
          const body = instanceNumber !== undefined ? { instance_number: instanceNumber } : {};
          const { data: result } = await envApi.enter({ id: envId }, body);
          const enterResult = result as {
            session_id?: string;
            instance_id?: string;
            environment_id?: string;
          } | null;
          onSelectInstance(
            enterResult?.instance_id ?? "",
            enterResult?.environment_id ?? envId,
            enterResult?.session_id ?? null,
          );
        } else {
          const { data: result } = await envApi.enter({ id: envId }, {});
          const enterResult = result as {
            session_id?: string;
            instance_id?: string;
            environment_id?: string;
          } | null;
          onSelectInstance(
            enterResult?.instance_id ?? "",
            enterResult?.environment_id ?? envId,
            enterResult?.session_id ?? null,
          );
        }

        setRefreshKey((k) => k + 1);
      } catch (err) {
        console.error("Failed to enter instance:", err);
        toast.error(
          t("enterInstanceFailed", {
            message: (err as Error).message,
          }),
        );
      } finally {
        setEnteringAgentId(null);
      }
    },
    [onSelectInstance, t],
  );

  // 重启单个实例
  const handleRestartInstance = useCallback(
    async (instanceId: string) => {
      const instExtra = instanceExtrasRef.current.get(instanceId);
      if (!instExtra) return;
      setRestartingIds((prev) => new Set(prev).add(instanceId));
      try {
        await instanceApi.delete({ id: instanceId });
        await instanceApi.spawn({ environmentId: instExtra.environmentId });
        setRefreshKey((k) => k + 1);
        toast.success(t("restartSuccess"));
      } catch (err) {
        console.error("Failed to restart instance:", err);
        toast.error(t("restartFailed", { message: (err as Error).message }));
      } finally {
        setRestartingIds((prev) => {
          const next = new Set(prev);
          next.delete(instanceId);
          return next;
        });
      }
    },
    [t],
  );

  // 停止单个实例
  const handleStopInstance = useCallback(
    async (instanceId: string) => {
      setStoppingIds((prev) => new Set(prev).add(instanceId));
      try {
        await instanceApi.delete({ id: instanceId });
        setRefreshKey((k) => k + 1);
        toast.success(t("stopSuccess"));
      } catch (err) {
        console.error("Failed to stop instance:", err);
        toast.error(t("stopInstanceFailed", { message: (err as Error).message }));
      } finally {
        setStoppingIds((prev) => {
          const next = new Set(prev);
          next.delete(instanceId);
          return next;
        });
      }
    },
    [t],
  );

  // 重启 agent 所有运行中实例
  const handleRestartAgent = useCallback(
    (agentId: string) => {
      const runningIds: string[] = [];
      for (const [id, extra] of instanceExtrasRef.current) {
        if (extra.agentId === agentId && (extra.status === "running" || extra.status === "starting")) {
          runningIds.push(id);
        }
      }
      if (runningIds.length === 0) {
        toast.info(t("noInstancesToRestart"));
        return;
      }
      if (runningIds.length === 1) {
        handleRestartInstance(runningIds[0]);
        return;
      }
      setRestartTargetAgentId(agentId);
      setSelectedRestartInstances(new Set(runningIds));
      setRestartDialogOpen(true);
    },
    [handleRestartInstance, t],
  );

  const handleRestartConfirm = useCallback(async () => {
    if (!restartTargetAgentId) return;
    setRestartDialogOpen(false);
    for (const instId of selectedRestartInstances) {
      await handleRestartInstance(instId);
    }
    setRestartTargetAgentId(null);
  }, [restartTargetAgentId, selectedRestartInstances, handleRestartInstance]);

  // 删除智能体
  const handleDeleteAgent = useCallback((agentId: string) => {
    setDeleteTargetAgentId(agentId);
    setDeleteDialogOpen(true);
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTargetAgentId) return;
    setDeleteDialogOpen(false);
    const extra = agentExtrasRef.current.get(deleteTargetAgentId);
    try {
      // 先停止所有运行中的实例
      const runningIds: string[] = [];
      for (const [id, instExtra] of instanceExtrasRef.current) {
        if (instExtra.agentId === deleteTargetAgentId) {
          runningIds.push(id);
        }
      }
      await Promise.all(runningIds.map((id) => instanceApi.delete({ id })));

      const agentName = extra?.agent.name ?? "";
      const { error } = await agentApi.delete(agentName);
      if (error) {
        toast.error(t("deleteFailed", { message: error.message }));
        return;
      }
      toast.success(t("deleteSuccess"));
      setRefreshKey((k) => k + 1);
    } catch (err) {
      console.error("Failed to delete agent:", err);
      toast.error(t("deleteFailed", { message: (err as Error).message }));
    } finally {
      setDeleteTargetAgentId(null);
    }
  }, [deleteTargetAgentId, t]);

  // 选中回调
  const handleSelect = useCallback(
    (nodeId: string | null, _node: TreeNodeData) => {
      if (!nodeId) return;
      if (agentExtrasRef.current.has(nodeId)) {
        handleEnterAgent(nodeId);
        return;
      }
      const instExtra = instanceExtrasRef.current.get(nodeId);
      if (instExtra) {
        handleEnterAgent(instExtra.agentId, { instanceId: nodeId });
      }
    },
    [handleEnterAgent],
  );

  // 轮询刷新
  useEffect(() => {
    const interval = setInterval(() => {
      setRefreshKey((k) => k + 1);
    }, 15_000);
    return () => clearInterval(interval);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: orgId 变化时需要重置加载状态
  useEffect(() => {
    setLoading(true);
    setRefreshKey((k) => k + 1);
  }, [orgId]);

  useConfigChangeListener((module) => {
    if (module === "agents") setRefreshKey((k) => k + 1);
  }, []);

  // agent 行操作按钮：重启、删除、设置
  const renderActions = useCallback(
    (node: TreeNodeData, _state: NodeState) => {
      if (agentExtrasRef.current.has(node.id)) {
        const isEntering = enteringAgentId === node.id;
        const isRestarting = [...instanceExtrasRef.current.values()]
          .filter((e) => e.agentId === node.id)
          .some((e) => restartingIds.has(e.instanceId));
        return (
          <>
            {isEntering && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            <button
              type="button"
              className="agent-tree-action-btn agent-tree-hover-action"
              disabled={isRestarting}
              onClick={(e) => {
                e.stopPropagation();
                handleRestartAgent(node.id);
              }}
              title={t("restartAgent")}
            >
              <RotateCw className={`w-3.5 h-3.5 ${isRestarting ? "animate-spin" : ""}`} />
            </button>
            <button
              type="button"
              className="agent-tree-action-btn agent-tree-hover-action text-red-400 hover:text-red-500"
              onClick={(e) => {
                e.stopPropagation();
                handleDeleteAgent(node.id);
              }}
              title={t("deleteAgent")}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              className="agent-tree-action-btn"
              onClick={(e) => {
                e.stopPropagation();
                onEditAgent?.(node.label);
              }}
              title={t("agentConfig")}
            >
              <Settings className="w-3.5 h-3.5" />
            </button>
          </>
        );
      }

      // instance 行：重启 + 停止按钮
      const instExtra = instanceExtrasRef.current.get(node.id);
      if (instExtra) {
        const isRestarting = restartingIds.has(node.id);
        const isStopping = stoppingIds.has(node.id);
        return (
          <>
            <button
              type="button"
              className="agent-tree-action-btn"
              disabled={isRestarting}
              onClick={(e) => {
                e.stopPropagation();
                handleRestartInstance(node.id);
              }}
              title={t("restart")}
            >
              <RotateCw className={`w-3.5 h-3.5 ${isRestarting ? "animate-spin" : ""}`} />
            </button>
            <button
              type="button"
              className="agent-tree-action-btn"
              disabled={isStopping}
              onClick={(e) => {
                e.stopPropagation();
                handleStopInstance(node.id);
              }}
              title={t("stop")}
            >
              <Square className="w-3.5 h-3.5" />
            </button>
          </>
        );
      }

      return null;
    },
    [
      enteringAgentId,
      restartingIds,
      stoppingIds,
      handleRestartAgent,
      handleDeleteAgent,
      handleRestartInstance,
      handleStopInstance,
      onEditAgent,
      t,
    ],
  );

  // 自定义 label：instance 行显示 status dot
  const renderLabel = useCallback(
    (node: TreeNodeData, _state: NodeState) => {
      const instExtra = instanceExtrasRef.current.get(node.id);
      if (instExtra) {
        const status = getInstanceStatus(instExtra.status);
        return (
          <span className="flex items-center gap-2">
            <span className={`status-dot ${status}`} />
            <span className="truncate">{node.label}</span>
          </span>
        );
      }
      return <>{node.label}</>;
    },
    [getInstanceStatus],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="h-4 w-4 animate-spin text-text-muted" />
      </div>
    );
  }

  if (agentExtrasRef.current.size === 0) {
    return (
      <div className="px-4 py-4 text-center">
        <Bot className="h-8 w-8 mx-auto mb-2 text-text-muted opacity-30" />
        <p className="text-xs text-text-muted mb-3">{t("noAgents")}</p>
        {onCreateAgent && (
          <button
            type="button"
            onClick={onCreateAgent}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            {t("createAgent")}
          </button>
        )}
      </div>
    );
  }

  // 获取重启弹窗需要的运行中实例列表
  const restartTargetInstances = restartTargetAgentId
    ? [...instanceExtrasRef.current.entries()]
        .filter(([, e]) => e.agentId === restartTargetAgentId && (e.status === "running" || e.status === "starting"))
        .map(([id, e]) => ({ id, ...e }))
    : [];

  const deleteTargetName = deleteTargetAgentId
    ? (agentExtrasRef.current.get(deleteTargetAgentId)?.agent.name ?? "")
    : "";

  return (
    <div className="flex-1 overflow-y-auto py-2">
      <div className="flex items-center justify-between px-4 pt-1 pb-2">
        <span className="agent-tree-section-title">{t("agents")}</span>
        {onCreateAgent && (
          <button
            type="button"
            onClick={onCreateAgent}
            title={t("createAgent")}
            className="w-6 h-6 flex items-center justify-center rounded-md hover:bg-surface-hover cursor-pointer transition-colors text-text-dim hover:text-text-primary"
          >
            <Plus className="w-4 h-4" />
          </button>
        )}
      </div>
      <Tree
        key={refreshKey}
        getChildren={getChildren}
        selectedId={selectedInstanceId}
        onSelect={handleSelect}
        renderActions={renderActions}
        renderLabel={renderLabel}
      />

      {/* 多实例重启选择弹窗 */}
      <AlertDialog open={restartDialogOpen} onOpenChange={setRestartDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("restartTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("restartDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          {restartTargetAgentId && (
            <div className="space-y-2 max-h-48 overflow-y-auto">
              <label className="flex items-center gap-2 px-2 py-1 text-sm font-medium">
                <Checkbox
                  checked={
                    restartTargetInstances.length > 0 &&
                    restartTargetInstances.every((inst) => selectedRestartInstances.has(inst.id))
                  }
                  onCheckedChange={(checked) => {
                    if (checked) {
                      setSelectedRestartInstances(new Set(restartTargetInstances.map((i) => i.id)));
                    } else {
                      setSelectedRestartInstances(new Set());
                    }
                  }}
                />
                {t("selectAll")}
              </label>
              {restartTargetInstances.map((inst) => (
                <label key={inst.id} className="flex items-center gap-2 px-2 py-1 text-sm">
                  <Checkbox
                    checked={selectedRestartInstances.has(inst.id)}
                    onCheckedChange={(checked) => {
                      setSelectedRestartInstances((prev) => {
                        const next = new Set(prev);
                        if (checked) next.add(inst.id);
                        else next.delete(inst.id);
                        return next;
                      });
                    }}
                  />
                  {t("instanceN", { number: inst.instanceNumber })}
                </label>
              ))}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{t("restartLater")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleRestartConfirm} disabled={selectedRestartInstances.size === 0}>
              {t("restartConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 删除智能体确认弹窗 */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteAgent")}</AlertDialogTitle>
            <AlertDialogDescription>{t("deleteAgentConfirm", { name: deleteTargetName })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("restartLater")}</AlertDialogCancel>
            <AlertDialogAction className="bg-red-500 hover:bg-red-600 focus:ring-red-500" onClick={handleDeleteConfirm}>
              {t("deleteAgent")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
