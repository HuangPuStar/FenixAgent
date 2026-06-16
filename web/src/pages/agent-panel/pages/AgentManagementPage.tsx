import { useNavigate } from "@tanstack/react-router";
import { Bot, Loader2, Plus, Search, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { agentApi, envApi } from "@/src/api/sdk";
import { AgentBadge } from "../../../../components/chat/AgentBadge";
import { NS } from "../../../i18n";
import { getAgentConfigLookupKey, getAgentDisplayName, isAgentWritable } from "../../../lib/agent-resource-access";
import { useConfigChangeListener } from "../../../lib/config-events";
import type { ResourceAccess } from "../../../types/config";
import type { Environment } from "../../../types/index";
import { AgentFormDialog } from "../AgentFormDialog";
import { AgentPageHeader } from "../shared/AgentPageHeader";

interface AgentConfigItem {
  id: string;
  name: string;
  builtIn?: boolean;
  model?: string | null;
  modelId?: string | null;
  modelLabel?: string | null;
  description?: string | null;
  resourceAccess?: ResourceAccess;
  skillLabels?: Array<{ id: string; label: string }>;
  machineId?: string | null;
}

interface AgentManageNode {
  agent: AgentConfigItem;
  environment: Environment | null;
}

type FilterId = "all" | "general" | "data" | "search" | "monitor" | "code" | "custom";

const FILTER_IDS: readonly FilterId[] = ["all", "general", "data", "search", "monitor", "code", "custom"] as const;

function useFilterLabels() {
  const { t } = useTranslation(NS.AGENTS);
  const { t: tc } = useTranslation(NS.COMPONENTS);
  return useMemo(
    () => ({
      all: tc("statusBadge.all"),
      general: t("categories.general", { defaultValue: "通用助理" }),
      data: t("categories.data", { defaultValue: "数据分析" }),
      search: t("categories.search", { defaultValue: "搜索检索" }),
      monitor: t("categories.monitor", { defaultValue: "监控告警" }),
      code: t("categories.code", { defaultValue: "代码助手" }),
      custom: t("categories.custom", { defaultValue: "自定义" }),
    }),
    [t, tc],
  );
}

function inferCategory(agent: AgentConfigItem): FilterId {
  const text = `${agent.name} ${agent.description ?? ""}`.toLowerCase();
  if (/(data|analyst|analysis|数据|分析|报表)/.test(text)) return "data";
  if (/(search|检索|搜索|知识)/.test(text)) return "search";
  if (/(monitor|alert|监控|告警)/.test(text)) return "monitor";
  if (/(code|coder|program|代码|编程|bug)/.test(text)) return "code";
  if (agent.resourceAccess?.ownership === "external") return "general";
  return "custom";
}

export function AgentManagementPage() {
  const navigate = useNavigate();
  const { t } = useTranslation(NS.AGENTS);
  const filterLabels = useFilterLabels();
  const [nodes, setNodes] = useState<AgentManageNode[]>([]);
  const [query, setQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<FilterId>("all");
  const [loading, setLoading] = useState(true);
  const [enteringId, setEnteringId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editAgentName, setEditAgentName] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [{ data: agentsResult }, { data: envsData }] = await Promise.all([agentApi.list(), envApi.list()]);
      const rawAgents = (agentsResult as unknown as { agents?: AgentConfigItem[] } | null)?.agents;
      const agents = Array.isArray(rawAgents) ? rawAgents.filter((agent) => !agent.builtIn) : [];
      const envs = Array.isArray(envsData) ? (envsData as Environment[]) : [];
      const envByConfigId = new Map<string, Environment>();

      for (const env of envs) {
        if (env.agent_config_id) envByConfigId.set(env.agent_config_id, env);
      }

      setNodes(agents.map((agent) => ({ agent, environment: envByConfigId.get(agent.id) ?? null })));
    } catch (err) {
      console.error("Failed to load agents:", err);
      toast.error(t("loadFailed", { defaultValue: "加载智能体失败" }));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void loadData();
  }, [loadData]);

  useConfigChangeListener(
    (module) => {
      if (module === "agents") void loadData();
    },
    [loadData],
  );

  const filteredNodes = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return nodes.filter((node) => {
      const category = inferCategory(node.agent);
      const matchesFilter = activeFilter === "all" || category === activeFilter;
      const displayName = getAgentDisplayName(node.agent).toLowerCase();
      const matchesQuery =
        normalized.length === 0 ||
        displayName.includes(normalized) ||
        node.agent.name.toLowerCase().includes(normalized) ||
        (node.agent.description ?? "").toLowerCase().includes(normalized);
      return matchesFilter && matchesQuery;
    });
  }, [activeFilter, nodes, query]);

  const handleEnterAgent = useCallback(
    async (node: AgentManageNode) => {
      setEnteringId(node.agent.id);
      try {
        let envId = node.environment?.id;
        if (!envId) {
          const { data: newEnv } = await envApi.create({
            name: `env-${node.agent.id.slice(0, 8)}`,
            agentConfigId: node.agent.id,
            autoStart: true,
          });
          envId = (newEnv as unknown as Environment | null)?.id;
        }

        if (!envId) {
          toast.error(t("envCreateFailed", { defaultValue: "创建运行环境失败" }));
          return;
        }

        const { data: result } = await envApi.enter({ id: envId }, {});
        const enterResult = result as { session_id?: string; environment_id?: string } | null;
        const targetEnvId = enterResult?.environment_id ?? envId;
        if (enterResult?.session_id) {
          void navigate({
            to: "/agent/chat/$agentId/$sessionId",
            params: { agentId: targetEnvId, sessionId: enterResult.session_id },
          });
        } else {
          void navigate({ to: "/agent/chat/$agentId", params: { agentId: targetEnvId } });
        }
      } catch (err) {
        console.error("Failed to enter agent:", err);
        toast.error(t("enterFailed", { defaultValue: "进入对话失败" }));
      } finally {
        setEnteringId(null);
      }
    },
    [navigate],
  );

  return (
    <div className="min-h-full overflow-auto bg-[#f4f7fb] px-8 py-7 text-[#14213d]">
      <AgentPageHeader
        title="智能体管理"
        subtitle="管理您的所有 AI 智能体，支持创建、编辑和对话"
        actions={
          <>
            <button
              type="button"
              onClick={() => navigate({ to: "/agent/home" })}
              className="inline-flex h-10 shrink-0 items-center gap-2 rounded-lg border border-[#d0d9e8] bg-white px-[22px] text-[13px] font-semibold text-[#4f607b] transition hover:border-[#b9cee8] hover:text-[#1677ff]"
            >
              <Sparkles className="h-4 w-4" />
              对话创建
            </button>
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="inline-flex h-10 shrink-0 items-center gap-2 rounded-lg bg-[#1677ff] px-[22px] text-[13px] font-semibold text-white shadow-[0_4px_14px_rgba(22,119,255,0.18)] transition hover:bg-[#0f67df]"
            >
              <Plus className="h-4 w-4" />
              创建智能体
            </button>
          </>
        }
      />

      {/* 搜索 + 筛选 */}
      <div className="mb-7 flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-md">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[#98a8bd]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索智能体名称..."
            className="h-10 w-full rounded-lg border border-[#dce5ef] bg-white pl-10 pr-4 text-[13px] text-[#1a2944] outline-none transition placeholder:text-[#99a8bc] focus:border-[#1677ff] focus:ring-4 focus:ring-[#1677ff]/10"
          />
        </div>
        {FILTER_IDS.map((filterId) => (
          <button
            key={filterId}
            type="button"
            onClick={() => setActiveFilter(filterId)}
            className={[
              "rounded-full px-3.5 py-1.5 text-[12px] font-medium transition",
              activeFilter === filterId
                ? "bg-[#1677ff] text-white shadow-[0_4px_10px_rgba(22,119,255,0.18)]"
                : "border border-[#e0e7f0] bg-white text-[#6f7f95] hover:border-[#b9cee8] hover:text-[#1677ff]",
            ].join(" ")}
          >
            {filterLabels[filterId]}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex h-72 items-center justify-center text-[#7f8da4]">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
          加载智能体...
        </div>
      ) : filteredNodes.length === 0 ? (
        <div className="flex h-72 flex-col items-center justify-center rounded-xl border border-dashed border-[#d8e2ef] bg-white/65 text-[#8a9ab0]">
          <Bot className="mb-3 h-10 w-10 opacity-50" />
          <div className="text-[15px] font-semibold text-[#56667d]">暂无智能体</div>
          <div className="mt-1 text-[13px]">点击右上角创建第一个智能体</div>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,224px)] gap-5 justify-center">
          {filteredNodes.map((node) => {
            const { agent } = node;
            const writable = isAgentWritable(agent);
            const isBusy = enteringId === agent.id;

            return (
              <AgentBadge
                key={agent.id}
                name={agent.name}
                description={agent.description || undefined}
                skills={agent.skillLabels ?? []}
                sourceOrg={agent.resourceAccess?.sourceOrganizationName}
                onEnter={() => void handleEnterAgent(node)}
                onEdit={writable ? () => setEditAgentName(getAgentConfigLookupKey(agent)) : undefined}
                isBusy={isBusy}
              />
            );
          })}
        </div>
      )}

      <AgentFormDialog open={createOpen} onOpenChange={setCreateOpen} mode="create" onSuccess={loadData} />
      <AgentFormDialog
        open={editAgentName !== null}
        onOpenChange={(open) => {
          if (!open) setEditAgentName(null);
        }}
        mode="edit"
        agentName={editAgentName ?? undefined}
        onSuccess={loadData}
      />
    </div>
  );
}
