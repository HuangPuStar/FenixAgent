import {
  Bot,
  ChevronDown,
  ChevronRight,
  Eye,
  Loader2,
  Plus,
  RotateCw,
  Settings,
  Sparkles,
  Square,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
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
import { Switch } from "@/components/ui/switch";
import { ensureMetaAgent } from "@/src/api/meta-agent";
import { agentApi, envApi, instanceApi, modelApi } from "@/src/api/sdk";
import { useOrg } from "../../contexts/OrgContext";
import { NS } from "../../i18n";
import {
  getAgentAccessBadgeKey,
  getAgentConfigLookupKey,
  getAgentDisplayName,
  isAgentWritable,
} from "../../lib/agent-resource-access";
import { useConfigChangeListener } from "../../lib/config-events";
import type { ModelEntry, ResourceAccess } from "../../types/config";
import type { Environment, EnvironmentInstance } from "../../types/index";

interface AgentConfigItem {
  id: string;
  name: string;
  builtIn: boolean;
  model: string | null;
  modelLabel?: string | null;
  description: string | null;
  color: string | null;
  resourceAccess?: ResourceAccess;
  machineId?: string | null;
}

function buildModelLabelMap(available: ModelEntry[]): Map<string, string> {
  return new Map(
    available.map((model) => {
      const source = model.providerResourceAccess?.sourceOrganizationName;
      const label = source ? `${source}/${model.fullId}` : model.fullId;
      return [model.stableFullId ?? model.fullId, label];
    }),
  );
}

interface AgentTreeNode {
  agent: AgentConfigItem;
  environment: Environment | null;
  instances: EnvironmentInstance[];
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
  const { t: tComponents } = useTranslation(NS.COMPONENTS);
  const { org } = useOrg();
  const orgId = org?.id;
  const [treeNodes, setTreeNodes] = useState<AgentTreeNode[]>([]);
  const [expandedAgents, setExpandedAgents] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [enteringAgentId, setEnteringAgentId] = useState<string | null>(null);
  const [restartingIds, setRestartingIds] = useState<Set<string>>(new Set());
  const [stoppingIds, setStoppingIds] = useState<Set<string>>(new Set());
  const [restartDialogOpen, setRestartDialogOpen] = useState(false);
  const [restartTargetNode, setRestartTargetNode] = useState<AgentTreeNode | null>(null);
  const [selectedRestartInstances, setSelectedRestartInstances] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<AgentConfigItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [modelLabelMap, setModelLabelMap] = useState<Map<string, string>>(new Map());

  // Meta Agent 显示控制
  const [showMetaAgent, setShowMetaAgent] = useState(
    () => localStorage.getItem("agent-panel:show-meta-agent") === "true",
  );
  const [metaAgentLoading, setMetaAgentLoading] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [{ data: agentsResult }, { data: envsData }, { data: modelsData }] = await Promise.all([
        agentApi.list(),
        envApi.list(),
        modelApi.get(),
      ]);

      const rawAgents = (agentsResult as unknown as { agents?: AgentConfigItem[] } | null)?.agents;
      const agents = Array.isArray(rawAgents) ? rawAgents : [];
      const envs = Array.isArray(envsData) ? (envsData as Environment[]) : [];
      const availableModels = Array.isArray((modelsData as { available?: ModelEntry[] } | null)?.available)
        ? (((modelsData as { available?: ModelEntry[] } | null)?.available ?? []) as ModelEntry[])
        : [];
      setModelLabelMap(buildModelLabelMap(availableModels));

      // 过滤内置智能体
      const userAgents = agents.filter((a) => !a.builtIn);

      // 建立 agentConfigId → environment 映射
      const envByConfigId = new Map<string, Environment>();
      for (const env of envs) {
        if (env.agent_config_id) {
          envByConfigId.set(env.agent_config_id, env);
        }
      }

      // 构建 tree nodes
      const nodes: AgentTreeNode[] = userAgents.map((agent) => ({
        agent,
        environment: envByConfigId.get(agent.id) ?? null,
        instances: [],
      }));

      // 加载有活跃实例的 environment 的 instances
      const activeEnvs = envs.filter((e) => (e.instances_count ?? 0) > 0);
      if (activeEnvs.length > 0) {
        const results = await Promise.allSettled(activeEnvs.map((env) => envApi.listInstances({ id: env.id })));
        const instMap: Record<string, EnvironmentInstance[]> = {};
        activeEnvs.forEach((env, i) => {
          const r = results[i];
          if (r.status === "fulfilled") {
            const instData = r.value.data as { instances?: EnvironmentInstance[] } | null;
            instMap[env.id] = instData?.instances ?? [];
          }
        });

        for (const node of nodes) {
          if (node.environment) {
            node.instances = instMap[node.environment.id] ?? [];
          }
        }
      }

      setTreeNodes(nodes);
    } catch (err) {
      console.error("Failed to load agent tree:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: orgId triggers reload on org switch
  useEffect(() => {
    setLoading(true);
    loadData();
    const interval = setInterval(loadData, 15_000);
    return () => clearInterval(interval);
  }, [loadData, orgId]);

  // 监听配置变更事件，agents 变更时立即刷新
  useConfigChangeListener(
    (module) => {
      if (module === "agents") loadData();
    },
    [loadData],
  );

  const getInstanceStatus = (instance: EnvironmentInstance) => {
    if (instance.status === "running") return "running";
    if (instance.status === "starting") return "starting";
    if (instance.status === "error") return "error";
    return "stopped";
  };

  // 进入智能体：如果没有 environment 则自动创建
  const handleEnterAgent = useCallback(
    async (node: AgentTreeNode, opts?: { instanceNumber?: number; spawnNew?: boolean }) => {
      const { agent, environment } = node;
      const { instanceNumber, spawnNew } = opts ?? {};
      setEnteringAgentId(agent.id);
      try {
        let envId = environment?.id;

        // 没有 environment，自动创建
        if (!envId) {
          const { data: newEnv } = await envApi.create({
            name: `env-${agent.id.slice(0, 8)}`,
            agentConfigId: agent.id,
            autoStart: true,
          });
          envId = (newEnv as unknown as Environment | null)?.id;
          if (!envId) {
            toast.error(t("enterInstanceFailed", { message: "Failed to create environment" }));
            return;
          }
          // 刷新数据以关联新建的 environment
          await loadData();
        }

        if (spawnNew) {
          // 新建实例：先 spawn，再 enter 指定 instance_number
          const { data: spawnResult } = await instanceApi.spawn({ environmentId: envId });
          const spawned = spawnResult as { instance_number?: number } | null;
          const newInstanceNumber = spawned?.instance_number;
          if (newInstanceNumber !== undefined) {
            const { data: result } = await envApi.enter({ id: envId }, { instance_number: newInstanceNumber });
            const enterResult = result as { session_id?: string; instance_id?: string; environment_id?: string } | null;
            onSelectInstance(
              enterResult?.instance_id ?? "",
              enterResult?.environment_id ?? envId,
              enterResult?.session_id ?? null,
            );
          }
        } else {
          // 进入已有实例
          const body = instanceNumber !== undefined ? { instance_number: instanceNumber } : {};
          const { data: result } = await envApi.enter({ id: envId }, body);
          const enterResult = result as { session_id?: string; instance_id?: string; environment_id?: string } | null;
          onSelectInstance(
            enterResult?.instance_id ?? "",
            enterResult?.environment_id ?? envId,
            enterResult?.session_id ?? null,
          );
        }

        // 刷新列表以展示新实例
        loadData();
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
    [onSelectInstance, t, loadData],
  );

  const getRunningInstances = useCallback((node: AgentTreeNode) => {
    return node.instances.filter((inst) => inst.status === "running" || inst.status === "starting");
  }, []);

  const handleRestartInstance = useCallback(
    async (node: AgentTreeNode, instance: EnvironmentInstance) => {
      const envId = node.environment?.id;
      if (!envId) return;
      setRestartingIds((prev) => new Set(prev).add(instance.id));
      try {
        await instanceApi.delete({ id: instance.id });
        await instanceApi.spawn({ environmentId: envId });

        // 通知 ChatPanel 重新连接
        window.dispatchEvent(new CustomEvent("agent:reconnect", { detail: { envId } }));

        await loadData();
        toast.success(t("restartSuccess"));
      } catch (err) {
        console.error("Failed to restart instance:", err);
        toast.error(t("restartFailed", { message: (err as Error).message }));
      } finally {
        setRestartingIds((prev) => {
          const next = new Set(prev);
          next.delete(instance.id);
          return next;
        });
      }
    },
    [t, loadData],
  );

  const handleStopInstance = useCallback(
    async (instanceId: string) => {
      setStoppingIds((prev) => new Set(prev).add(instanceId));
      try {
        await instanceApi.delete({ id: instanceId });
        await loadData();
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
    [t, loadData],
  );

  const handleDeleteAgent = useCallback(
    async (agent: AgentConfigItem) => {
      setDeleting(true);
      try {
        const { error } = await agentApi.delete(agent.name);
        if (error) {
          toast.error(t("deleteFailed", { message: error.message }));
          return;
        }
        toast.success(t("deleteSuccess"));
        await loadData();
      } catch (err) {
        console.error("Failed to delete agent:", err);
        toast.error(t("deleteFailed", { message: (err as Error).message }));
      } finally {
        setDeleting(false);
        setDeleteTarget(null);
      }
    },
    [t, loadData],
  );

  const handleRestartAgent = useCallback(
    (node: AgentTreeNode) => {
      const running = getRunningInstances(node);
      if (running.length === 0) {
        toast.info(t("noInstancesToRestart"));
        return;
      }
      if (running.length === 1) {
        handleRestartInstance(node, running[0]);
        return;
      }
      setRestartTargetNode(node);
      setSelectedRestartInstances(new Set(running.map((i) => i.id)));
      setRestartDialogOpen(true);
    },
    [getRunningInstances, handleRestartInstance, t],
  );

  const handleRestartConfirm = useCallback(async () => {
    if (!restartTargetNode) return;
    const running = getRunningInstances(restartTargetNode);
    const targets = running.filter((inst) => selectedRestartInstances.has(inst.id));
    setRestartDialogOpen(false);
    for (const inst of targets) {
      await handleRestartInstance(restartTargetNode, inst);
    }
    setRestartTargetNode(null);
  }, [restartTargetNode, getRunningInstances, selectedRestartInstances, handleRestartInstance]);

  // 持久化 Meta Agent 显示状态
  useEffect(() => {
    localStorage.setItem("agent-panel:show-meta-agent", String(showMetaAgent));
  }, [showMetaAgent]);

  // 进入 Meta Agent
  const handleEnterMetaAgent = useCallback(async () => {
    setMetaAgentLoading(true);
    try {
      const result = await ensureMetaAgent();
      onSelectInstance(result.instanceId ?? "", result.environmentId, null);
    } catch (err) {
      console.error("Failed to start Meta Agent:", err);
      toast.error(t("metaAgentFailed"));
    } finally {
      setMetaAgentLoading(false);
    }
  }, [onSelectInstance, t]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="h-4 w-4 animate-spin text-text-muted" />
      </div>
    );
  }

  if (treeNodes.length === 0) {
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

  return (
    <div className="flex-1 overflow-y-auto py-2 space-y-2">
      <div className="flex items-center justify-between px-4 pt-1 pb-2">
        <span className="agent-tree-section-title">{t("agents")}</span>
        <div className="flex items-center gap-1">
          <label
            className="flex items-center gap-1 cursor-pointer text-text-dim hover:text-text-secondary transition-colors"
            title={t("metaAgentToggle")}
          >
            <Sparkles className="w-3.5 h-3.5" />
            <Switch size="sm" checked={showMetaAgent} onCheckedChange={setShowMetaAgent} />
          </label>
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
      </div>
      {/* Meta Agent 卡片 */}
      {showMetaAgent && (
        <div className="mx-2 mb-2">
          <button
            type="button"
            disabled={metaAgentLoading}
            onClick={handleEnterMetaAgent}
            className={[
              "flex items-center gap-2.5 w-full p-2.5",
              "border border-brand/30 rounded-[10px] bg-gradient-to-r from-brand/5 to-brand/10",
              "cursor-pointer text-left font-[inherit]",
              "transition-all duration-150",
              "hover:border-brand/50 hover:shadow-sm",
              "disabled:opacity-60 disabled:cursor-not-allowed",
            ].join(" ")}
          >
            <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-gradient-to-br from-brand to-brand-light text-white">
              {metaAgentLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-semibold text-text-primary truncate">{t("metaAgent")}</div>
              <div className="text-[11px] text-text-dim truncate mt-0.5">{t("metaAgentDesc")}</div>
            </div>
          </button>
        </div>
      )}
      {treeNodes.map((node) => {
        const { agent, instances } = node;
        const collapsed = !expandedAgents[agent.id];
        const isEntering = enteringAgentId === agent.id;
        const runningInstances = getRunningInstances(node);
        const isRestarting = runningInstances.some((inst) => restartingIds.has(inst.id));
        const writable = isAgentWritable(agent);
        const displayName = getAgentDisplayName(agent);

        return (
          <div key={agent.id} className="group relative mx-2">
            {/* 卡片主体 */}
            <button
              type="button"
              disabled={isEntering}
              onClick={() => handleEnterAgent(node)}
              className={[
                "flex items-center gap-2.5 w-full p-2.5",
                "border border-border-subtle rounded-[10px] bg-surface-1",
                "cursor-pointer text-left font-[inherit]",
                "transition-all duration-150",
                "hover:bg-surface-hover hover:border-border-default hover:shadow-sm",
                "disabled:opacity-60 disabled:cursor-not-allowed",
              ].join(" ")}
            >
              {/* 头像 */}
              {/* <div
                className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 overflow-hidden"
                style={{ background: avatarBg }}
              >
                {isEntering ? (
                  <Loader2 className="w-4 h-4 animate-spin text-white" />
                ) : (
                  <span className="text-white font-bold text-sm">{initial}</span>
                )}
              </div> */}

              {/* 名称 + 描述 */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <div className="text-[13px] font-semibold text-text-primary truncate">{displayName}</div>
                  <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-text-muted">
                    {tComponents(getAgentAccessBadgeKey(agent))}
                  </span>
                </div>
                <div className="text-[11px] text-text-dim truncate mt-0.5">
                  {agent.description ||
                    agent.modelLabel ||
                    (agent.model ? (modelLabelMap.get(agent.model) ?? agent.model) : null) ||
                    t("agentDefaultDesc")}
                </div>
                {agent.resourceAccess?.ownership === "external" && (
                  <div className="text-[10px] text-text-muted mt-0.5">
                    {t("sharedFrom", {
                      source: agent.resourceAccess.sourceOrganizationName ?? agent.resourceAccess.sourceOrganizationId,
                    })}
                  </div>
                )}
                {agent.machineId && (
                  <div className="flex items-center gap-1 mt-0.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0" />
                    <span className="text-[10px] text-text-muted">{t("remoteNode")}</span>
                  </div>
                )}
              </div>
            </button>

            {/* 悬浮操作栏 */}
            <div className="absolute top-1.5 right-1.5 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                type="button"
                className="flex items-center justify-center w-6 h-6 border-none rounded-md bg-surface-2 text-text-dim cursor-pointer hover:bg-surface-hover hover:text-text-primary transition-colors disabled:opacity-50"
                onClick={() =>
                  setExpandedAgents((prev) => ({
                    ...prev,
                    [agent.id]: !prev[agent.id],
                  }))
                }
                title={collapsed ? t("expandInstances") : t("collapseInstances")}
              >
                {collapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </button>
              <button
                type="button"
                className="flex items-center justify-center w-6 h-6 border-none rounded-md bg-surface-2 text-text-dim cursor-pointer hover:bg-surface-hover hover:text-text-primary transition-colors disabled:opacity-50"
                disabled={isRestarting}
                onClick={(e) => {
                  e.stopPropagation();
                  handleRestartAgent(node);
                }}
                title={t("restartAgent")}
              >
                <RotateCw className={`w-3.5 h-3.5 ${isRestarting ? "animate-spin" : ""}`} />
              </button>
              <button
                type="button"
                className="flex items-center justify-center w-6 h-6 border-none rounded-md bg-surface-2 text-text-dim cursor-pointer hover:bg-surface-hover hover:text-text-primary transition-colors"
                onClick={(e) => {
                  e.stopPropagation();
                  onEditAgent?.(getAgentConfigLookupKey(agent));
                }}
                title={writable ? t("agentConfig") : t("viewAgentConfig")}
              >
                {writable ? <Settings className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
              {writable && !agent.builtIn && (
                <button
                  type="button"
                  className="flex items-center justify-center w-6 h-6 border-none rounded-md bg-surface-2 text-text-dim cursor-pointer hover:bg-red-500/10 hover:text-red-500 transition-colors"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleteTarget(agent);
                  }}
                  title={t("deleteAgent")}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* 展开的实例列表 */}
            {!collapsed && (
              <div className="mt-1 py-0.5">
                {instances.length > 0
                  ? instances.map((inst) => {
                      const isInstRestarting = restartingIds.has(inst.id);
                      const isInstStopping = stoppingIds.has(inst.id);
                      return (
                        <div
                          key={inst.id}
                          className={[
                            "group flex items-center gap-2 px-3 py-1.5 ml-2 text-[13px] rounded-md cursor-pointer transition-colors",
                            selectedInstanceId === inst.id
                              ? "bg-brand-subtle text-brand"
                              : "text-text-primary hover:bg-surface-hover",
                          ].join(" ")}
                          onClick={() => handleEnterAgent(node, { instanceNumber: inst.instance_number })}
                        >
                          <span className={`status-dot ${getInstanceStatus(inst)}`} />
                          <span className="truncate">{t("instanceN", { number: inst.instance_number })}</span>
                          <div className="ml-auto flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                            <button
                              type="button"
                              className="flex items-center justify-center w-5.5 h-5.5 border-none rounded bg-transparent text-text-dim cursor-pointer hover:bg-surface-hover hover:text-text-primary transition-colors disabled:opacity-50"
                              disabled={isInstRestarting}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleRestartInstance(node, inst);
                              }}
                              title={t("restart")}
                            >
                              <RotateCw className={`w-3.5 h-3.5 ${isInstRestarting ? "animate-spin" : ""}`} />
                            </button>
                            <button
                              type="button"
                              className="flex items-center justify-center w-5.5 h-5.5 border-none rounded bg-transparent text-text-dim cursor-pointer hover:bg-surface-hover hover:text-text-primary transition-colors disabled:opacity-50"
                              disabled={isInstStopping}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleStopInstance(inst.id);
                              }}
                              title={t("stop")}
                            >
                              <Square className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      );
                    })
                  : null}
                <button
                  type="button"
                  disabled={isEntering}
                  onClick={() => handleEnterAgent(node, { spawnNew: true })}
                  title={t("newInstance")}
                  className="flex items-center gap-1.5 px-3 py-1 ml-2 text-[13px] text-text-dim cursor-pointer border-none rounded-md bg-transparent hover:bg-surface-hover hover:text-text-secondary transition-colors whitespace-nowrap"
                >
                  <Plus className="w-3.5 h-3.5 shrink-0" />
                  <span>{t("newInstance")}</span>
                </button>
              </div>
            )}
          </div>
        );
      })}

      {/* 多实例重启选择弹窗 */}
      <AlertDialog open={restartDialogOpen} onOpenChange={setRestartDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("restartTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("restartDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          {restartTargetNode && (
            <div className="space-y-2 max-h-48 overflow-y-auto">
              <label className="flex items-center gap-2 px-2 py-1 text-sm font-medium">
                <Checkbox
                  checked={
                    getRunningInstances(restartTargetNode).length > 0 &&
                    getRunningInstances(restartTargetNode).every((inst) => selectedRestartInstances.has(inst.id))
                  }
                  onCheckedChange={(checked) => {
                    if (checked) {
                      setSelectedRestartInstances(new Set(getRunningInstances(restartTargetNode).map((i) => i.id)));
                    } else {
                      setSelectedRestartInstances(new Set());
                    }
                  }}
                />
                {t("selectAll")}
              </label>
              {getRunningInstances(restartTargetNode).map((inst) => (
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
                  {t("instanceN", { number: inst.instance_number })}
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
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteAgent")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteAgentConfirm", { name: deleteTarget ? getAgentDisplayName(deleteTarget) : "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              onClick={() => deleteTarget && handleDeleteAgent(deleteTarget)}
              className="bg-red-600 hover:bg-red-700"
            >
              {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : t("deleteAgent")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
