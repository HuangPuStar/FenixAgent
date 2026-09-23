import { type EnvironmentDetail, envApi } from "@fenix/agent-runtime/web/api/environments";
import { AgentBadge } from "@fenix/ui-components/chat/shell/AgentBadge";
import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { AppHeader } from "@fenix/ui-components/layout/app-header";
import { AppPage } from "@fenix/ui-components/layout/app-page";
import { Spinner } from "@fenix/ui-components/ui/spinner";
import { unwrap } from "@fenix/web-runtime/api/request";
import { useOrgSession } from "@fenix/web-runtime/contexts/org-session";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { useConfigChangeListener } from "@fenix/web-runtime/lib/config-events";
import type { AgentInfo } from "@fenix/web-runtime/types/config";
import { useNavigate } from "@tanstack/react-router";
import { useRequest } from "ahooks";
import { AlertTriangle, Bot, Plus, RefreshCw, Search, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { agentApi } from "../../../api/agents";
import { getAgentConfigLookupKey, getAgentDisplayName, isExternalAgent } from "../../../lib/agent-resource-access";
import { AgentFormDialog } from "../agent-editor/AgentFormDialog";
import "./AgentManagementPage.css";

interface AgentManageNode {
  agent: AgentInfo;
  environment: EnvironmentDetail | null;
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

/**
 * 粗粒度归类；仅用于筛选分组，不参与任何授权判断。
 *
 * 跨组织资源统一归入 "general"：它们的名称/描述是对方组织写的，按关键词归类会把共享 Agent 散落到
 * 各分组里，用户难以预期。是否需要 `activeOrganizationId` 由调用方注入（组织上下文未就绪时按本组织处理）。
 */
function inferCategory(agent: AgentInfo, activeOrganizationId?: string): FilterId {
  const text = `${agent.name} ${agent.description ?? ""}`.toLowerCase();
  if (/(data|analyst|analysis|数据|分析|报表)/.test(text)) return "data";
  if (/(search|检索|搜索|知识)/.test(text)) return "search";
  if (/(monitor|alert|监控|告警)/.test(text)) return "monitor";
  if (/(code|coder|program|代码|编程|bug)/.test(text)) return "code";
  if (isExternalAgent(agent, activeOrganizationId)) return "general";
  return "custom";
}

export function AgentManagementPage() {
  const navigate = useNavigate();
  const { t } = useTranslation(NS.AGENTS);
  // 组织上下文经 §1.6 T7 的平台中立契约取（`useOrg()` 会构成 resource → platform-impl 禁止边）。
  // 契约投影用 `null` 表示「未解析出组织」，本页内部沿用可选参数的 `undefined` 语义。
  const { organizationId } = useOrgSession();
  const orgId = organizationId ?? undefined;
  const filterLabels = useFilterLabels();
  const [query, setQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<FilterId>("all");
  const [enteringId, setEnteringId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editAgentName, setEditAgentName] = useState<string | null>(null);
  const [editorHost, setEditorHost] = useState<HTMLDivElement | null>(null);

  // 列表查询：并行拉取 Agent 配置与环境列表，按 agentConfigId 关联
  const {
    data: nodes,
    loading,
    error: listError,
    refresh,
  } = useRequest(
    async (): Promise<AgentManageNode[]> => {
      const [agentsResult, envsList] = await Promise.all([unwrap(agentApi.list()), unwrap(envApi.list())]);
      const agents = (agentsResult.agents ?? []).filter((agent) => !agent.builtIn);
      const envs = Array.isArray(envsList) ? envsList : [];
      const envByConfigId = new Map<string, EnvironmentDetail>();
      for (const env of envs) {
        if (env.agentConfigId) envByConfigId.set(env.agentConfigId, env);
      }
      return agents.map((agent) => ({ agent, environment: envByConfigId.get(agent.id) ?? null }));
    },
    {
      onError: (err) => {
        console.error("Failed to load agents:", err);
        toast.error(t("loadFailed", { defaultValue: "加载智能体失败" }));
      },
    },
  );

  // 配置变更时刷新列表
  useConfigChangeListener(
    (module) => {
      if (module === "agents") refresh();
    },
    [refresh],
  );

  const filteredNodes = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return (nodes ?? []).filter((node) => {
      const category = inferCategory(node.agent, orgId);
      const matchesFilter = activeFilter === "all" || category === activeFilter;
      const displayName = getAgentDisplayName(node.agent).toLowerCase();
      const matchesQuery =
        normalized.length === 0 ||
        displayName.includes(normalized) ||
        node.agent.name.toLowerCase().includes(normalized) ||
        (node.agent.description ?? "").toLowerCase().includes(normalized);
      return matchesFilter && matchesQuery;
    });
  }, [activeFilter, nodes, query, orgId]);

  // 进入 Agent（可能需要先创建环境）
  const { run: runEnter } = useRequest(
    async (node: AgentManageNode) => {
      setEnteringId(node.agent.id);
      let envId = node.environment?.id;
      if (!envId) {
        // 不存在关联环境时自动创建
        const newEnv = await unwrap(
          envApi.create({
            name: `env-${node.agent.id.slice(0, 8)}`,
            agentConfigId: node.agent.id,
            autoStart: true,
          }),
        );
        envId = newEnv?.id;
      }
      if (!envId) {
        toast.error(t("envCreateFailed"));
        return;
      }
      const enterResult = await unwrap(envApi.enter({ id: envId }, {}));
      const targetEnvId = enterResult.environmentId ?? envId;
      if (enterResult.instanceUid) {
        void navigate({
          to: "/agent/chat/$agentId/$sessionId",
          params: { agentId: targetEnvId, sessionId: enterResult.instanceUid },
        });
      } else {
        void navigate({ to: "/agent/chat/$agentId", params: { agentId: targetEnvId } });
      }
    },
    {
      manual: true,
      onError: (err) => {
        console.error("Failed to enter agent:", err);
        toast.error(t("enterFailed", { defaultValue: "进入对话失败" }));
      },
      onFinally: () => setEnteringId(null),
    },
  );

  return (
    <AppPage>
      {/* 这一层既是页面内容包裹层，也是「新建 / 编辑 Agent」面板的 portal 宿主（`portalContainer={editorHost}`）。
          桌面面板是 `absolute top-3 bottom-3 left-3` 的 12px 内缩工作区，高度直接取自宿主盒子，所以宿主
          必须**撑满页面**而不是只有内容高度：`flex-1`（`AppPage` 的 `main` 是 flex 列）让宿主在 Agent 少时
          也占满可视区，否则面板只有内容那么高——实测 720px 视口下只有 333px，即「半屏」（2026-09-23 修）。
          面板自身的「不得高过视口」上限在 `agent-editor-classes.css` 的 `.agent-editor-panel`。 */}
      <div ref={setEditorHost} className="relative flex-1">
        <AppHeader
          title={t("management.title")}
          subtitle={t("management.subtitle")}
          actions={
            <>
              <button
                type="button"
                onClick={() => navigate({ to: "/agent/home" })}
                className="inline-flex h-10 shrink-0 items-center gap-2 rounded-lg border border-border bg-background px-5.5 text-xs font-semibold text-text-muted transition hover:border-primary/40 hover:text-primary"
              >
                <Sparkles className="h-4 w-4" />
                {t("management.createByChat")}
              </button>
              <button
                type="button"
                onClick={() => setCreateOpen(true)}
                className="inline-flex h-10 shrink-0 items-center gap-2 rounded-lg bg-primary px-5.5 text-xs font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90"
              >
                <Plus className="h-4 w-4" />
                {t("management.createAgent")}
              </button>
            </>
          }
        />

        {/* 搜索 + 筛选 */}
        <div className="mb-7 flex flex-wrap items-center gap-2" role="group" aria-label={t("management.filters")}>
          <div className="relative w-full max-w-md">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label={t("management.search")}
              placeholder={t("management.searchPlaceholder")}
              className="h-10 w-full rounded-lg border border-border bg-background pl-10 pr-4 text-xs text-foreground outline-none transition placeholder:text-text-muted focus:border-primary focus:ring-4 focus:ring-primary/10"
            />
          </div>
          {FILTER_IDS.map((filterId) => (
            <button
              key={filterId}
              type="button"
              aria-pressed={activeFilter === filterId}
              onClick={() => setActiveFilter(filterId)}
              className={[
                "rounded-full px-3.5 py-1.5 text-xs font-medium transition",
                activeFilter === filterId
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "border border-border bg-background text-text-muted hover:border-primary/40 hover:text-primary",
              ].join(" ")}
            >
              {filterLabels[filterId]}
            </button>
          ))}
        </div>

        {loading ? (
          <Spinner size="sm" label={t("management.loading")} className="flex h-72" aria-busy="true" />
        ) : listError && filteredNodes.length === 0 ? (
          // 首次取数失败：`nodes` 停在 `undefined`，若照旧往下走只会渲染「暂无智能体」空态——
          // 与「确实还没有智能体」同形（§3.4）。判据带 `filteredNodes.length === 0`：刷新失败时
          // 保留已经渲染的列表，不让一次失败掀掉用户正在看的内容。文案走本包字典，原始错误只进日志。
          <EmptyState
            icon={<AlertTriangle />}
            title={t("management.loadFailedTitle")}
            description={t("management.loadFailedDescription")}
            tone="danger"
            role="alert"
            className="flex h-72 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-background/65"
            action={{ label: t("management.retry"), onClick: refresh, icon: <RefreshCw />, disabled: loading }}
          />
        ) : filteredNodes.length === 0 ? (
          <div className="flex h-72 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-background/65 text-text-muted">
            <Bot className="mb-3 h-10 w-10 opacity-50" />
            <div className="text-sm font-semibold text-foreground">{t("management.emptyTitle")}</div>
            <div className="mt-1 text-xs">{t("management.emptyDescription")}</div>
          </div>
        ) : (
          <div className="agent-management-grid grid gap-5 justify-center">
            {filteredNodes.map((node) => {
              const { agent } = node;
              const isBusy = enteringId === agent.id;

              return (
                <AgentBadge
                  key={agent.id}
                  name={agent.name}
                  description={agent.description || undefined}
                  skills={agent.skillLabels ?? []}
                  sourceOrg={isExternalAgent(agent, orgId) ? agent.organizationName : undefined}
                  onEnter={() => runEnter(node)}
                  onEdit={() => setEditAgentName(getAgentConfigLookupKey(agent))}
                  isBusy={isBusy}
                />
              );
            })}
          </div>
        )}

        <AgentFormDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          mode="create"
          portalContainer={editorHost}
          onSuccess={refresh}
        />
        <AgentFormDialog
          open={editAgentName !== null}
          onOpenChange={(open) => {
            if (!open) setEditAgentName(null);
          }}
          mode="edit"
          agentName={editAgentName ?? ""}
          portalContainer={editorHost}
        />
      </div>
    </AppPage>
  );
}
