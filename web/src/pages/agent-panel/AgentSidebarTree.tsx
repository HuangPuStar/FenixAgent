import { useNavigate } from "@tanstack/react-router";
import { useRequest } from "ahooks";
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
import { memo, useEffect, useRef, useState } from "react";
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
import { agentApi } from "@/src/api/agents";
import { envApi } from "@/src/api/environments";
import { instanceApi } from "@/src/api/instances";
import { ensureMetaAgent } from "@/src/api/meta-agent";
import { unwrap } from "@/src/api/request";
import { useOrg } from "../../contexts/OrgContext";
import { NS } from "../../i18n";
import {
  getAgentAccessBadgeKey,
  getAgentConfigLookupKey,
  getAgentDisplayName,
  isAgentWritable,
} from "../../lib/agent-resource-access";
import { dispatchConfigChange, useConfigChangeListener } from "../../lib/config-events";
import type { ResourceAccess } from "../../types/config";
import type { Environment, EnvironmentInstance } from "../../types/index";

interface AgentConfigItem {
  id: string;
  name: string;
  builtIn: boolean;
  model: string | null;
  modelId?: string | null;
  modelLabel?: string | null;
  description: string | null;
  resourceAccess?: ResourceAccess;
  machineId?: string | null;
}

interface AgentTreeNode {
  agent: AgentConfigItem;
  environment: Environment | null;
  instances: EnvironmentInstance[];
}

interface AgentSidebarTreeProps {
  selectedInstanceId: string | null;
  selectedEnvironmentId?: string | null;
  onSelectInstance: (instanceId: string, envId: string, sessionId: string | null) => void;
  onCreateAgent?: () => void;
  onEditAgent?: (agentName: string) => void;
}

export const AgentSidebarTree = memo(function AgentSidebarTree({
  selectedInstanceId,
  selectedEnvironmentId = null,
  onSelectInstance,
  onCreateAgent,
  onEditAgent,
}: AgentSidebarTreeProps) {
  const { t } = useTranslation(NS.AGENT_PANEL);
  const { t: tComponents } = useTranslation(NS.COMPONENTS);
  const { org } = useOrg();
  const orgId = org?.id;
  const navigate = useNavigate();

  // 交互状态
  const [expandedAgents, setExpandedAgents] = useState<Record<string, boolean>>({});
  const [restartDialogOpen, setRestartDialogOpen] = useState(false);
  const [restartTargetNode, setRestartTargetNode] = useState<AgentTreeNode | null>(null);
  const [selectedRestartInstances, setSelectedRestartInstances] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<AgentConfigItem | null>(null);

  // 进入/重启/停止操作的标识追踪：记录正在操作的目标及操作类型
  const [enteringTargetId, setEnteringTargetId] = useState<string | null>(null);
  const [pendingInstanceId, setPendingInstanceId] = useState<{ id: string; type: "restart" | "stop" } | null>(null);

  // Meta Agent 显示控制
  const [showMetaAgent, setShowMetaAgent] = useState(
    () => localStorage.getItem("agent-panel:show-meta-agent") === "true",
  );

  // environmentId → agentConfigId 映射：用于判断当前对话页打开的环境属于哪个 agent 配置。
  // 相比 treeNodes 每个 agent 只保留单个环境，这里覆盖全部环境，避免多环境场景漏判。
  const envConfigMapRef = useRef<Map<string, string>>(new Map());

  // ---- 数据加载（带 15s 轮询）----
  const {
    data: treeNodes = [],
    loading,
    refresh,
  } = useRequest(
    async (): Promise<AgentTreeNode[]> => {
      const [agentsResult, envs] = await Promise.all([unwrap(agentApi.list()), unwrap(envApi.list())]);

      const agents = Array.isArray(agentsResult.agents) ? agentsResult.agents : [];

      // 过滤内置智能体
      const userAgents = agents.filter((a) => !a.builtIn);

      // 建立 agentConfigId → environment 映射
      const envByConfigId = new Map<string, Environment>();
      // 同步刷新 environmentId → agentConfigId 全量映射（含同一 agent 的多个环境）
      const envConfigMap = new Map<string, string>();
      for (const env of envs) {
        const configId = env.agentConfigId;
        if (configId) {
          envByConfigId.set(configId, env as unknown as Environment);
          if (env.id) envConfigMap.set(env.id, configId);
        }
      }
      envConfigMapRef.current = envConfigMap;

      // 构建 tree nodes
      const nodes: AgentTreeNode[] = userAgents.map((agent) => ({
        agent,
        environment: envByConfigId.get(agent.id) ?? null,
        instances: [],
      }));

      // 加载有活跃实例的 environment 的 instances
      const activeEnvs = envs.filter((e) => (e.instancesCount ?? 0) > 0);
      if (activeEnvs.length > 0) {
        const results = await Promise.allSettled(activeEnvs.map((env) => unwrap(envApi.listInstances({ id: env.id }))));
        const instMap: Record<string, EnvironmentInstance[]> = {};
        activeEnvs.forEach((env, i) => {
          const r = results[i];
          if (r.status === "fulfilled") {
            instMap[env.id] = (r.value.instances ?? []) as unknown as EnvironmentInstance[];
          }
        });

        for (const node of nodes) {
          if (node.environment) {
            node.instances = instMap[node.environment.id] ?? [];
          }
        }
      }

      return nodes;
    },
    { pollingInterval: 15_000, refreshDeps: [orgId], ready: !!orgId, loadingDelay: 300 },
  );

  // 监听配置变更事件，agents 变更时立即刷新
  useConfigChangeListener(
    (module) => {
      if (module === "agents") refresh();
    },
    [refresh],
  );

  // 持久化 Meta Agent 显示状态
  useEffect(() => {
    localStorage.setItem("agent-panel:show-meta-agent", String(showMetaAgent));
  }, [showMetaAgent]);

  // ---- 实例状态辅助 ----
  const getInstanceStatus = (instance: EnvironmentInstance) => {
    if (instance.status === "running") return "running";
    if (instance.status === "starting") return "starting";
    if (instance.status === "error") return "error";
    return "stopped";
  };

  const getRunningInstances = (node: AgentTreeNode) => {
    return node.instances.filter((inst) => inst.status === "running" || inst.status === "starting");
  };

  // ---- 进入智能体（manual useRequest）----
  const { run: runEnter, loading: entering } = useRequest(
    async (node: AgentTreeNode, opts?: { instanceNumber?: number; spawnNew?: boolean }) => {
      const { agent, environment } = node;
      const { instanceNumber, spawnNew } = opts ?? {};
      setEnteringTargetId(agent.id);

      let envId = environment?.id;

      // 没有 environment，自动创建
      if (!envId) {
        const newEnv = await unwrap(
          envApi.create({
            name: `env-${agent.id.slice(0, 8)}`,
            agentConfigId: agent.id,
            autoStart: true,
          }),
        );
        envId = newEnv.id;
        if (!envId) {
          throw new Error("Failed to create environment");
        }
        // 刷新数据以关联新建的 environment
        await refresh();
      }

      let enterResult: { instanceId?: string; environmentId?: string; sessionId?: string | null };

      if (spawnNew) {
        // 新建实例：先 spawn，再 enter 指定 instance_number
        const spawned = await unwrap(instanceApi.spawn({ environmentId: envId }));
        const newInstanceNumber = spawned.instanceNumber;
        if (newInstanceNumber !== undefined) {
          enterResult = await unwrap(envApi.enter({ id: envId }, { instance_number: newInstanceNumber }));
        } else {
          throw new Error("Failed to get instance number after spawn");
        }
      } else {
        // 进入已有实例
        const body = instanceNumber !== undefined ? { instance_number: instanceNumber } : {};
        enterResult = await unwrap(envApi.enter({ id: envId }, body));
      }

      onSelectInstance(enterResult.instanceId ?? "", enterResult.environmentId ?? envId, enterResult.sessionId ?? null);

      // 刷新列表以展示新实例
      refresh();
    },
    {
      manual: true,
      onFinally: () => setEnteringTargetId(null),
      onError: (err) => {
        console.error("Failed to enter instance:", err);
        toast.error(
          t("enterInstanceFailed", {
            message: (err as Error).message,
          }),
        );
      },
    },
  );

  // ---- 重启实例（manual useRequest）----
  const { run: runRestart, loading: restarting } = useRequest(
    async (node: AgentTreeNode, instance: EnvironmentInstance) => {
      const envId = node.environment?.id;
      if (!envId) throw new Error("No environment found for restart");

      setPendingInstanceId({ id: instance.id, type: "restart" });

      await unwrap(instanceApi.delete({ id: instance.id }));
      await unwrap(instanceApi.spawn({ environmentId: envId }));

      // 通知 ChatPanel 重新连接
      window.dispatchEvent(new CustomEvent("agent:reconnect", { detail: { envId } }));

      await refresh();
      toast.success(t("restartSuccess"));
    },
    {
      manual: true,
      onFinally: () => setPendingInstanceId(null),
      onError: (err) => {
        console.error("Failed to restart instance:", err);
        toast.error(t("restartFailed", { message: (err as Error).message }));
      },
    },
  );

  // ---- 停止实例（manual useRequest）----
  const { run: runStop, loading: _stopping } = useRequest(
    async (instanceId: string) => {
      setPendingInstanceId({ id: instanceId, type: "stop" });

      await unwrap(instanceApi.delete({ id: instanceId }));
      await refresh();
      toast.success(t("stopSuccess"));
    },
    {
      manual: true,
      onFinally: () => setPendingInstanceId(null),
      onError: (err) => {
        console.error("Failed to stop instance:", err);
        toast.error(t("stopInstanceFailed", { message: (err as Error).message }));
      },
    },
  );

  // ---- 删除智能体（manual useRequest）----
  const { run: runDeleteAgent, loading: deleting } = useRequest(
    async (agent: AgentConfigItem) => {
      // 删除前判断：当前对话页打开的环境是否属于该 agent 配置。
      // 通过 environmentId → agentConfigId 映射比对，兼容同一 agent 存在多个环境的情况。
      const openConfigId = selectedEnvironmentId ? (envConfigMapRef.current.get(selectedEnvironmentId) ?? null) : null;
      const deletingOpenAgent = openConfigId !== null && openConfigId === agent.id;

      await unwrap(agentApi.delete(agent.name));
      toast.success(t("deleteSuccess"));

      // 通知其它页面（如智能体管理页）刷新列表
      dispatchConfigChange("agents");
      await refresh();

      // 若删除的正是当前对话页打开的智能体，切换到新建智能体页面
      if (deletingOpenAgent) {
        void navigate({ to: "/agent/home" });
      }
    },
    {
      manual: true,
      onFinally: () => setDeleteTarget(null),
      onError: (err) => {
        console.error("Failed to delete agent:", err);
        toast.error(t("deleteFailed", { message: (err as Error).message }));
      },
    },
  );

  // ---- Meta Agent（manual useRequest）----
  const { run: runMetaAgent, loading: metaAgentLoading } = useRequest(
    async () => {
      const result = await ensureMetaAgent();
      onSelectInstance(result.instanceId ?? "", result.environmentId, null);
    },
    {
      manual: true,
      onError: (err) => {
        console.error("Failed to start Meta Agent:", err);
        toast.error(t("metaAgentFailed"));
      },
    },
  );

  // ---- 批量重启辅助函数 ----
  const handleRestartAgent = (node: AgentTreeNode) => {
    const running = getRunningInstances(node);
    if (running.length === 0) {
      toast.info(t("noInstancesToRestart"));
      return;
    }
    if (running.length === 1) {
      runRestart(node, running[0]);
      return;
    }
    setRestartTargetNode(node);
    setSelectedRestartInstances(new Set(running.map((i) => i.id)));
    setRestartDialogOpen(true);
  };

  const handleRestartConfirm = async () => {
    if (!restartTargetNode) return;
    const running = getRunningInstances(restartTargetNode);
    const targets = running.filter((inst) => selectedRestartInstances.has(inst.id));
    setRestartDialogOpen(false);
    // 逐个重启选中实例；onError 已处理 toast 通知
    for (const inst of targets) {
      try {
        await runRestart(restartTargetNode, inst);
      } catch {
        // onError 已弹出 toast，此处仅阻止异常中断循环
      }
    }
    setRestartTargetNode(null);
  };

  // ---- 渲染 ----
  if (loading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="h-4 w-4 animate-spin text-text-muted" />
      </div>
    );
  }

  if (!treeNodes || treeNodes.length === 0) {
    return (
      <div className="agent-sidebar-empty px-4 py-4 text-center">
        <Bot className="h-8 w-8 mx-auto mb-2 text-text-muted opacity-30" />
        <p className="text-xs text-text-muted mb-3">{t("noAgents")}</p>
        {onCreateAgent && (
          <button
            type="button"
            onClick={onCreateAgent}
            className="agent-sidebar-create-btn inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            {t("createAgent")}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="agent-sidebar-tree flex-1 overflow-y-auto pb-2">
      <div className="sticky top-0 z-10 flex items-center justify-between pr-4 pb-4">
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
              className="agent-sidebar-icon-btn w-6 h-6 flex items-center justify-center rounded-md hover:bg-surface-hover cursor-pointer transition-colors text-text-dim hover:text-text-primary"
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
            onClick={runMetaAgent}
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
        // 通过 entering + enteringTargetId 组合判断具体哪个 agent 正在进入
        const isEntering = entering && enteringTargetId === agent.id;
        const runningInstances = getRunningInstances(node);
        const isAgentSelected =
          node.environment?.id === selectedEnvironmentId || instances.some((inst) => inst.id === selectedInstanceId);
        // agent 级别的重启中状态：该 agent 下有实例正在重启
        const isRestarting =
          restarting &&
          pendingInstanceId?.type === "restart" &&
          runningInstances.some((inst) => inst.id === pendingInstanceId?.id);
        const writable = isAgentWritable(agent);
        const displayName = getAgentDisplayName(agent);
        // 拆分 key/名称 格式：前半为标识键，后半为显示名
        const slashIdx = displayName.indexOf("/");
        const agentLabel = slashIdx >= 0 ? displayName.slice(slashIdx + 1) : displayName;
        const agentKey = slashIdx >= 0 ? displayName.slice(0, slashIdx) : "";
        // 访问标签：仅 public/external 展示（internal 不显示徽标）
        const accessBadgeKey = agent.resourceAccess ? getAgentAccessBadgeKey(agent) : "resource.internal";

        return (
          <div key={agent.id} className="agent-sidebar-agent group relative">
            {/* 卡片主体 */}
            <button
              type="button"
              disabled={isEntering}
              onClick={() => runEnter(node)}
              className={[
                "agent-sidebar-agent-card flex items-center gap-2.5 w-full",
                "border border-border-subtle rounded-[10px] bg-surface-1",
                "cursor-pointer text-left font-[inherit]",
                "transition-all duration-150",
                "hover:bg-surface-hover hover:border-border-default hover:shadow-sm",
                "disabled:opacity-60 disabled:cursor-not-allowed",
                isAgentSelected ? "active" : "",
              ].join(" ")}
            >
              {/* 两行：显示名 + 标识键 */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <div className="text-[13px] font-semibold text-text-primary truncate">{agentLabel}</div>
                  {/* 仅公有/外部显示标签，用高对比配色区分（public=蓝，external=琥珀），避免与灰底混淆看不清 */}
                  {accessBadgeKey !== "resource.internal" && (
                    <span
                      className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium ${
                        accessBadgeKey === "resource.public"
                          ? "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300"
                          : "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300"
                      }`}
                    >
                      {tComponents(accessBadgeKey)}
                    </span>
                  )}
                </div>
                {/* 第二行：标识键 + 远程标记 */}
                {(agentKey || agent.machineId) && (
                  <div className="text-[10px] text-text-muted truncate flex items-center gap-1.5">
                    {agentKey && <span className="font-mono truncate">{agentKey}</span>}
                    {agent.machineId && (
                      <>
                        <span className="w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0" />
                        <span className="shrink-0">{t("remoteNode")}</span>
                      </>
                    )}
                  </div>
                )}
              </div>
            </button>

            {/* 悬浮操作栏 */}
            <div className="agent-sidebar-actions absolute top-1.5 right-1.5 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
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
                      // per-instance 操作状态：通过 pendingInstanceId 精确匹配实例 ID 和操作类型
                      const isInstRestarting =
                        pendingInstanceId?.id === inst.id && pendingInstanceId?.type === "restart";
                      const isInstStopping = pendingInstanceId?.id === inst.id && pendingInstanceId?.type === "stop";
                      return (
                        <div
                          key={inst.id}
                          className={[
                            "agent-sidebar-instance group flex items-center gap-2 px-3 py-1.5 ml-2 text-[13px] rounded-md cursor-pointer transition-colors",
                            selectedInstanceId === inst.id
                              ? "bg-brand-subtle text-brand"
                              : "text-text-primary hover:bg-surface-hover",
                          ].join(" ")}
                          onClick={() => runEnter(node, { instanceNumber: inst.instanceNumber })}
                        >
                          <span className={`status-dot ${getInstanceStatus(inst)}`} />
                          <span className="truncate">{t("instanceN", { number: inst.instanceNumber })}</span>
                          <div className="ml-auto flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                            <button
                              type="button"
                              className="flex items-center justify-center w-5.5 h-5.5 border-none rounded bg-transparent text-text-dim cursor-pointer hover:bg-surface-hover hover:text-text-primary transition-colors disabled:opacity-50"
                              disabled={isInstRestarting}
                              onClick={(e) => {
                                e.stopPropagation();
                                runRestart(node, inst);
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
                                runStop(inst.id);
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
                  onClick={() => runEnter(node, { spawnNew: true })}
                  title={t("newInstance")}
                  className="agent-sidebar-new-instance flex items-center gap-1.5 px-3 py-1 ml-2 text-[13px] text-text-dim cursor-pointer border-none rounded-md bg-transparent hover:bg-surface-hover hover:text-text-secondary transition-colors whitespace-nowrap"
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
              onClick={() => deleteTarget && runDeleteAgent(deleteTarget)}
              className="bg-red-600 hover:bg-red-700"
            >
              {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : t("deleteAgent")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
});
