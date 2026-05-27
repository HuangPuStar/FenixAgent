import { Bot, Loader2, Plus, Settings } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
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

// 业务上下文：agent 节点需要额外的 environmentId 信息
interface AgentExtra {
  agent: AgentConfigItem;
  environmentId: string | null;
}

interface InstanceExtra {
  agentId: string;
  environmentId: string;
  instanceNumber: number;
  status: string;
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

  // 业务数据缓存（Tree 组件只持有 TreeNodeData，额外字段存这里）
  const agentExtrasRef = useRef<Map<string, AgentExtra>>(new Map());
  const instanceExtrasRef = useRef<Map<string, InstanceExtra>>(new Map());
  const [loading, setLoading] = useState(true);
  const [enteringAgentId, setEnteringAgentId] = useState<string | null>(null);
  // 强制刷新：改变 key 触发 Tree 组件重新挂载
  const [refreshKey, setRefreshKey] = useState(0);

  const getInstanceStatus = useCallback((instance: EnvironmentInstance) => {
    if (instance.status === "running") return "running";
    if (instance.status === "starting") return "starting";
    if (instance.status === "error") return "error";
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

    // 更新业务缓存
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

      // 更新实例业务缓存
      for (const inst of instances) {
        instanceExtrasRef.current.set(inst.id, {
          agentId,
          environmentId: extra.environmentId,
          instanceNumber: inst.instance_number,
          status: inst.status,
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

  // getChildren 回调传给 Tree
  const getChildren = useCallback(
    async (parentId: string | null): Promise<TreeNodeData[]> => {
      try {
        if (parentId === null) {
          const agents = await loadAgents();
          setLoading(false);
          return agents;
        }
        // 二级：检查是 agent 还是 instance 的 id
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
          // 进入默认实例
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

  // 选中回调
  const handleSelect = useCallback(
    (nodeId: string | null, _node: TreeNodeData) => {
      if (!nodeId) return;

      // 点击 agent 行 → 进入默认实例
      if (agentExtrasRef.current.has(nodeId)) {
        handleEnterAgent(nodeId);
        return;
      }

      // 点击 instance 行 → 进入指定实例
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

  // 配置变更时刷新
  useConfigChangeListener((module) => {
    if (module === "agents") setRefreshKey((k) => k + 1);
  }, []);

  // 行内操作按钮
  const renderActions = useCallback(
    (node: TreeNodeData, _state: NodeState) => {
      // agent 行：显示 settings 按钮
      if (agentExtrasRef.current.has(node.id)) {
        const isEntering = enteringAgentId === node.id;
        return (
          <>
            {isEntering && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onEditAgent?.(node.label);
              }}
              title={t("agentConfig")}
              className="w-5 h-5 flex items-center justify-center rounded hover:bg-surface-hover flex-shrink-0 text-text-dim hover:text-text-primary transition-colors"
            >
              <Settings size={14} />
            </button>
          </>
        );
      }

      // instance 行：无操作按钮
      return null;
    },
    [enteringAgentId, onEditAgent, t],
  );

  // 自定义 label 渲染（instance 行显示 status dot）
  const renderLabel = useCallback(
    (node: TreeNodeData, _state: NodeState) => {
      const instExtra = instanceExtrasRef.current.get(node.id);
      if (instExtra) {
        const status = getInstanceStatus({ status: instExtra.status } as EnvironmentInstance);
        return (
          <span className="flex items-center gap-2">
            <span className={`status-dot ${status}`} />
            <span className="truncate">{node.label}</span>
          </span>
        );
      }
      // agent 行用默认渲染
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

  // 空状态检查：agentExtrasRef 为空时显示
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
    </div>
  );
}
