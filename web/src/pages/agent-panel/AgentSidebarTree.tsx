import { Bot, ChevronDown, ChevronRight, Loader2, Plus, Settings } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
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
  const { org } = useOrg();
  const _orgId = org?.id;
  const [treeNodes, setTreeNodes] = useState<AgentTreeNode[]>([]);
  const [collapsedAgents, setCollapsedAgents] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [enteringAgentId, setEnteringAgentId] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [{ data: agentsResult }, { data: envsData }] = await Promise.all([agentApi.list(), envApi.list()]);

      const rawAgents = (agentsResult as unknown as { agents?: AgentConfigItem[] } | null)?.agents;
      const agents = Array.isArray(rawAgents) ? rawAgents : [];
      const envs = Array.isArray(envsData) ? (envsData as Environment[]) : [];

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

  useEffect(() => {
    setLoading(true);
    loadData();
    const interval = setInterval(loadData, 15_000);
    return () => clearInterval(interval);
  }, [loadData]);

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

  const _handleStopInstance = useCallback(
    async (instanceId: string) => {
      try {
        await instanceApi.delete({ id: instanceId });
        await loadData();
      } catch (err) {
        console.error("Failed to stop instance:", err);
        toast.error(
          t("stopInstanceFailed", {
            message: (err as Error).message,
          }),
        );
      }
    },
    [loadData, t],
  );

  // 进入智能体：如果没有 environment 则自动创建
  const handleEnterAgent = useCallback(
    async (node: AgentTreeNode, instanceNumber?: number) => {
      const { agent, environment } = node;
      setEnteringAgentId(agent.id);
      try {
        let envId = environment?.id;

        // 没有 environment，自动创建
        if (!envId) {
          const { data: newEnv } = await envApi.create({
            name: agent.name,
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

        // 进入 environment
        const body = instanceNumber !== undefined ? { instance_number: instanceNumber } : {};
        const { data: result } = await envApi.enter({ id: envId }, body);
        const enterResult = result as { session_id?: string; instance_id?: string; environment_id?: string } | null;
        onSelectInstance(
          enterResult?.instance_id ?? "",
          enterResult?.environment_id ?? envId,
          enterResult?.session_id ?? null,
        );
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
      {treeNodes.map((node, idx) => {
        const { agent, instances } = node;
        const collapsed = !!collapsedAgents[agent.id];
        const isEntering = enteringAgentId === agent.id;
        return (
          <div key={agent.id} className={idx > 0 ? "mt-1.5" : ""}>
            <button
              type="button"
              onClick={() =>
                setCollapsedAgents((prev) => ({
                  ...prev,
                  [agent.id]: !prev[agent.id],
                }))
              }
              className="agent-tree-env-header"
            >
              {collapsed ? (
                <ChevronRight className="w-3.5 h-3.5 flex-shrink-0" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5 flex-shrink-0" />
              )}
              {isEntering ? (
                <Loader2 className="w-4 h-4 flex-shrink-0 animate-spin" />
              ) : (
                <Bot className="w-4 h-4 flex-shrink-0" />
              )}
              <span className="truncate">{agent.name}</span>
              {instances.length > 0 && <span className="agent-tree-instance-count">{instances.length}</span>}

              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  onEditAgent?.(agent.name);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.stopPropagation();
                    onEditAgent?.(agent.name);
                  }
                }}
                title={t("agentConfig")}
                className={`w-5 h-5 flex items-center justify-center rounded hover:bg-surface-hover flex-shrink-0 text-text-dim hover:text-text-primary transition-colors${instances.length === 0 ? " ml-auto" : ""}`}
              >
                <Settings size={14} />
              </span>
            </button>
            {!collapsed && (
              <div className="agent-tree-env-body">
                <button
                  type="button"
                  disabled={isEntering}
                  onClick={() => handleEnterAgent(node)}
                  title={t("newInstance")}
                  className="agent-tree-new-instance"
                >
                  <Plus className="w-3.5 h-3.5 flex-shrink-0" />
                  <span>{t("newInstance")}</span>
                </button>
                {instances.length > 0
                  ? instances.map((inst) => (
                      <div
                        key={inst.id}
                        className={`agent-tree-instance ${selectedInstanceId === inst.id ? "selected" : ""}`}
                        onClick={() => handleEnterAgent(node, inst.instance_number)}
                      >
                        <span className={`status-dot ${getInstanceStatus(inst)}`} />
                        <span className="truncate">
                          {t("instanceN", {
                            number: inst.instance_number,
                          })}
                        </span>
                      </div>
                    ))
                  : null}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
