import { useNavigate } from "@tanstack/react-router";
import { Bot, Loader2, MessageSquare, Pencil, Plus, Search, ShieldCheck, Trash2, UserRound } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { agentApi, envApi } from "@/src/api/sdk";
import { getAgentConfigLookupKey, getAgentDisplayName, isAgentWritable } from "../../../lib/agent-resource-access";
import { useConfigChangeListener } from "../../../lib/config-events";
import type { ResourceAccess } from "../../../types/config";
import type { Environment } from "../../../types/index";
import { AgentFormDialog } from "../AgentFormDialog";

interface AgentConfigItem {
  id: string;
  name: string;
  builtIn?: boolean;
  model?: string | null;
  modelId?: string | null;
  modelLabel?: string | null;
  description?: string | null;
  resourceAccess?: ResourceAccess;
  skillLabels?: string[];
  machineId?: string | null;
}

interface AgentManageNode {
  agent: AgentConfigItem;
  environment: Environment | null;
}

const FILTERS = [
  { id: "all", label: "全部" },
  { id: "general", label: "通用助理" },
  { id: "data", label: "数据分析" },
  { id: "search", label: "搜索检索" },
  { id: "monitor", label: "监控告警" },
  { id: "code", label: "代码助手" },
  { id: "custom", label: "自定义" },
] as const;

const CARD_ACCENTS = ["#21c792", "#f5aa18", "#ff5a62", "#6a72f6", "#36a2ff", "#23bfd4"];

type FilterId = (typeof FILTERS)[number]["id"];

function inferCategory(agent: AgentConfigItem): FilterId {
  const text = `${agent.name} ${agent.description ?? ""}`.toLowerCase();
  if (/(data|analyst|analysis|数据|分析|报表)/.test(text)) return "data";
  if (/(search|检索|搜索|知识)/.test(text)) return "search";
  if (/(monitor|alert|监控|告警)/.test(text)) return "monitor";
  if (/(code|coder|program|代码|编程|bug)/.test(text)) return "code";
  if (agent.resourceAccess?.ownership === "external") return "general";
  return "custom";
}

function getSkillCount(agent: AgentConfigItem) {
  if (Array.isArray(agent.skillLabels)) return agent.skillLabels.length;
  return 0;
}

function getStatus(node: AgentManageNode) {
  const env = node.environment;
  if (!env) return "stopped";
  if ((env.instances_count ?? 0) > 0) return "running";
  if (env.status === "running" || env.status === "starting") return "running";
  return "stopped";
}

function AgentInitial({ agent, accent }: { agent: AgentConfigItem; accent: string }) {
  const displayName = getAgentDisplayName(agent);
  return (
    <div
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl font-bold text-white"
      style={{ background: accent }}
    >
      {displayName.charAt(0).toUpperCase()}
    </div>
  );
}

export function AgentManagementPage() {
  const navigate = useNavigate();
  const [nodes, setNodes] = useState<AgentManageNode[]>([]);
  const [query, setQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<FilterId>("all");
  const [loading, setLoading] = useState(true);
  const [enteringId, setEnteringId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
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
      toast.error("加载智能体失败");
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
          toast.error("创建运行环境失败");
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
        toast.error("进入对话失败");
      } finally {
        setEnteringId(null);
      }
    },
    [navigate],
  );

  const handleDeleteAgent = useCallback(
    async (agent: AgentConfigItem) => {
      if (!window.confirm(`确定删除智能体「${getAgentDisplayName(agent)}」吗？`)) return;
      setDeletingId(agent.id);
      try {
        const { error } = await agentApi.delete(agent.name);
        if (error) {
          toast.error(error.message || "删除失败");
          return;
        }
        toast.success("已删除智能体");
        await loadData();
      } catch (err) {
        console.error("Failed to delete agent:", err);
        toast.error("删除失败");
      } finally {
        setDeletingId(null);
      }
    },
    [loadData],
  );

  return (
    <div className="min-h-full overflow-auto bg-[#f4f7fb] px-8 py-7 text-[#14213d]">
      <div className="mb-7 flex items-center justify-between gap-4">
        <h1 className="text-[28px] font-bold tracking-tight text-[#1474ff]">智能体管理</h1>
      </div>

      <div className="mb-6 flex items-center gap-5">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-4.5 w-4.5 -translate-y-1/2 text-[#98a8bd]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索智能体名称..."
            className="h-11 w-full rounded-lg border border-[#dce5ef] bg-white px-11 text-[14px] text-[#1a2944] shadow-sm outline-none transition placeholder:text-[#99a8bc] focus:border-[#1677ff] focus:ring-4 focus:ring-[#1677ff]/10"
          />
        </div>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="inline-flex h-11 shrink-0 items-center gap-2 rounded-lg bg-[#1677ff] px-6 text-[14px] font-semibold text-white shadow-[0_10px_20px_rgba(22,119,255,0.22)] transition hover:bg-[#0f67df]"
        >
          <Plus className="h-4 w-4" />
          创建智能体
        </button>
      </div>

      <div className="mb-7 flex flex-wrap gap-3">
        {FILTERS.map((filter) => (
          <button
            key={filter.id}
            type="button"
            onClick={() => setActiveFilter(filter.id)}
            className={[
              "h-9 rounded-full px-5 text-[13px] font-semibold transition",
              activeFilter === filter.id
                ? "bg-[#1677ff] text-white shadow-[0_8px_18px_rgba(22,119,255,0.2)]"
                : "border border-[#e0e7f0] bg-white text-[#6f7f95] hover:border-[#b9cee8] hover:text-[#1677ff]",
            ].join(" ")}
          >
            {filter.label}
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
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-2 2xl:grid-cols-4">
          {filteredNodes.map((node, index) => {
            const { agent } = node;
            const accent = CARD_ACCENTS[index % CARD_ACCENTS.length];
            const category = FILTERS.find((filter) => filter.id === inferCategory(agent))?.label ?? "自定义";
            const status = getStatus(node);
            const writable = isAgentWritable(agent);
            const isBusy = enteringId === agent.id;
            const isDeleting = deletingId === agent.id;

            return (
              <article
                key={agent.id}
                className="group overflow-hidden rounded-sm border border-[#e1e8f2] bg-white shadow-[0_10px_24px_rgba(43,71,112,0.05)]"
              >
                <div className="h-[3px]" style={{ background: accent }} />
                <div className="relative p-5">
                  <div className="absolute right-3 top-3 flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
                    <button
                      type="button"
                      onClick={() => setEditAgentName(getAgentConfigLookupKey(agent))}
                      className="flex h-6 w-6 items-center justify-center rounded text-[#8a9ab0] hover:bg-[#eef4fb] hover:text-[#1677ff]"
                      title={writable ? "编辑" : "查看"}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    {writable && (
                      <button
                        type="button"
                        disabled={isDeleting}
                        onClick={() => void handleDeleteAgent(agent)}
                        className="flex h-6 w-6 items-center justify-center rounded text-[#8a9ab0] hover:bg-[#fff0f0] hover:text-[#e5484d] disabled:opacity-60"
                        title="删除"
                      >
                        {isDeleting ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
                      </button>
                    )}
                  </div>

                  <div className="flex items-start gap-3 pr-12">
                    <AgentInitial agent={agent} accent={accent} />
                    <div className="min-w-0">
                      <div className="truncate text-[16px] font-bold text-[#17233d]">{getAgentDisplayName(agent)}</div>
                      <div className="mt-1 inline-flex max-w-full items-center rounded-full bg-[#eef3f9] px-2 py-0.5 text-[12px] font-medium text-[#8a98ab]">
                        <span className="truncate">{category}智能体</span>
                      </div>
                    </div>
                  </div>

                  <div
                    className={[
                      "mt-4 inline-flex items-center rounded-full px-3 py-1 text-[12px] font-semibold",
                      status === "running" ? "bg-[#e7fbf2] text-[#20b877]" : "bg-[#eef2f7] text-[#8998ad]",
                    ].join(" ")}
                  >
                    <span
                      className={[
                        "mr-1.5 h-1.5 w-1.5 rounded-full",
                        status === "running" ? "bg-[#23c982]" : "bg-[#96a6ba]",
                      ].join(" ")}
                    />
                    {status === "running" ? "运行中" : "已停止"}
                  </div>

                  <p className="mt-4 line-clamp-2 min-h-[44px] text-[14px] leading-[22px] text-[#69788f]">
                    {agent.description || "暂无描述"}
                  </p>

                  <div className="mt-5 flex items-center gap-5 border-t border-[#e8eef5] pt-4 text-[12px] font-semibold text-[#8796ab]">
                    <span>
                      模型{" "}
                      <b className="ml-1 text-[#34435b]">{agent.modelLabel ?? agent.model ?? agent.modelId ?? "-"}</b>
                    </span>
                    <span>
                      技能 <b className="ml-1 text-[#34435b]">{getSkillCount(agent)}</b>
                    </span>
                    {agent.machineId && (
                      <span className="inline-flex items-center gap-1">
                        <ShieldCheck className="h-3.5 w-3.5" />
                        远程
                      </span>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 border-t border-[#e8eef5] bg-[#f8fbff] p-3">
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => void handleEnterAgent(node)}
                    className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-[#1677ff] text-[13px] font-semibold text-white transition hover:bg-[#0f67df] disabled:opacity-60"
                  >
                    {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageSquare className="h-4 w-4" />}
                    进入对话
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditAgentName(getAgentConfigLookupKey(agent))}
                    className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-[#d9e2ee] bg-white text-[13px] font-semibold text-[#65748a] transition hover:border-[#b9cee8] hover:text-[#1677ff]"
                  >
                    <UserRound className="h-4 w-4" />
                    {writable ? "编辑" : "查看"}
                  </button>
                </div>
              </article>
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
