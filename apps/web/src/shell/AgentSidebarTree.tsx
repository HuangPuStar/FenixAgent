/**
 * Agent 侧边栏树的容器组件。
 *
 * 拆分后（§4.7 文件规模）本文件只做装配与渲染：数据与操作来自 `useAgentSidebarTree`，
 * 派生工具来自 `agent-sidebar-tree-model`，确认弹窗来自 `AgentSidebarTreeDialogs`。
 * 树展开状态与 Meta Agent 开关只影响渲染，仍由本组件持有。
 *
 * 导出面与拆分前一致：`AgentSidebarTree` 与 `orderInstancesByRunningStatus`（后者在此转发）。
 */
import { shouldShowRemoteNode } from "@fenix/agent-config/web/lib/agent-node";
import {
  getAgentAccessBadgeKey,
  getAgentConfigLookupKey,
  getAgentDisplayName,
  isAgentWritable,
} from "@fenix/agent-config/web/lib/agent-resource-access";
import { useOrg } from "@fenix/identity/web";
import type { StatusTone } from "@fenix/ui-components/config/StatusBadge";
import { StatusBadge } from "@fenix/ui-components/config/StatusBadge";
import { Spinner } from "@fenix/ui-components/ui/spinner";
import { StatusDot } from "@fenix/ui-components/ui/status-dot";
import { Switch } from "@fenix/ui-components/ui/switch";
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
import { memo, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { NS } from "@/src/i18n";
import { AgentSidebarDeleteDialog, AgentSidebarRestartDialog } from "./AgentSidebarTreeDialogs";
import { getInstanceStatusTone, getRunningInstances, orderInstancesByRunningStatus } from "./agent-sidebar-tree-model";
import { useAgentSidebarTree } from "./use-agent-sidebar-tree";

// 转发排序工具的唯一实现：既有消费方（含 `agent-sidebar-instance-order` 用例）仍从本模块导入。
export { orderInstancesByRunningStatus } from "./agent-sidebar-tree-model";

/**
 * 元智能体卡片主标题刻度。
 *
 * 与 agent item 名称（`AGENT_ITEM_TITLE_CLASS`）**刻意不同档**，不是漏改：agent item 已压成一行，
 * 名称要给同一行里的副信息让位才上调一档；元智能体卡片仍是「图标 + 标题 + 说明」两行结构，维持原刻度。
 * 两处被后人「对齐」回去，列表的行内层级会一起变形。
 */
const META_CARD_TITLE_CLASS = "text-xs font-semibold text-text-primary truncate";

/**
 * agent item 名称刻度（比元智能体卡片标题大一档：`text-xs` → `text-sm`，12px → 14px）。
 *
 * 为什么带 `min-w-0`：名称是 flex 行内的项目，flex 项目的 `min-width: auto` 会把宽度撑回内容宽度，
 * 缺了它同行的 `truncate` 压不下去；截断另有 `title` 兜底，见渲染点。
 */
const AGENT_ITEM_TITLE_CLASS = "text-sm font-semibold text-text-primary truncate min-w-0";

/**
 * agent 卡片悬浮操作栏的图标按钮刻度（展开 / 重启 / 配置三个按钮同名同级）。
 *
 * 三个按钮此前各写一遍同一串类名，调其中一处（比如把 `w-6` 改成 `w-7`）会让另外两个静默停在旧刻度上。
 * 配置按钮永不进入禁用态，仍带上 `disabled:opacity-50`——该变体只在 `:disabled` 命中时生效，写成同一份
 * 刻度比让它少一条更像「另一类按钮」。删除按钮是红色调的危险动作，不并入本刻度。
 */
const AGENT_ACTION_BUTTON_CLASS =
  "flex items-center justify-center w-6 h-6 border-none rounded-md bg-surface-2 text-text-dim cursor-pointer hover:bg-surface-hover hover:text-text-primary transition-colors disabled:opacity-50";

/** 实例行悬浮操作栏的图标按钮刻度（重启 / 停止两处同名同级）。 */
const INSTANCE_ACTION_BUTTON_CLASS =
  "flex items-center justify-center w-5.5 h-5.5 border-none rounded bg-transparent text-text-dim cursor-pointer hover:bg-surface-hover hover:text-text-primary transition-colors disabled:opacity-50";

/**
 * 访问级别的色调词表：`resource.public` = 可对外/被他组织引用，`resource.external` = 外部组织资源。
 *
 * 用色调而不是色名（`text-blue-700` / `bg-amber-100` 这类）：色名一旦写进业务，同一语义会在各页面
 * 各演化一套绿/蓝，深浅色变体也要跟着各写一份。色调只声明「这类访问级别算哪一类信息」，
 * 具体色值（含深浅色）由组件库的 `StatusBadge` 决定。`resource.internal` 不展示徽标、故不登记——
 * 未命中一律按 `neutral`，不会臆断成某一类。
 */
const ACCESS_BADGE_TONES: Record<string, StatusTone> = {
  "resource.public": "info",
  "resource.external": "warning",
};

interface AgentSidebarTreeProps {
  selectedInstanceId: string | null;
  selectedEnvironmentId?: string | null;
  onSelectInstance: (instanceId: string, envId: string, sessionId: string | null) => void;
  onCreateAgent?: () => void;
  onEditAgent?: (agentName: string) => void;
  onDeleteAgentEnvironments?: (environmentIds: string[]) => void;
}

export const AgentSidebarTree = memo(function AgentSidebarTree({
  selectedInstanceId,
  selectedEnvironmentId = null,
  onSelectInstance,
  onCreateAgent,
  onEditAgent,
  onDeleteAgentEnvironments,
}: AgentSidebarTreeProps) {
  const { t } = useTranslation(NS.AGENT_PANEL);
  const { t: tComponents } = useTranslation(NS.COMPONENTS);
  const { org } = useOrg();
  const orgId = org?.id;

  // 交互状态
  const [expandedAgents, setExpandedAgents] = useState<Record<string, boolean>>({});

  // Meta Agent 显示控制
  const [showMetaAgent, setShowMetaAgent] = useState(
    () => localStorage.getItem("agent-panel:show-meta-agent") === "true",
  );

  // 持久化 Meta Agent 显示状态
  useEffect(() => {
    localStorage.setItem("agent-panel:show-meta-agent", String(showMetaAgent));
  }, [showMetaAgent]);

  // 树数据、五组 mutation 与重启/删除会话状态（实现见 use-agent-sidebar-tree.ts）
  const {
    treeNodes,
    loading,
    showInitialLoading,
    runEnter,
    entering,
    enteringTargetId,
    runRestart,
    restarting,
    pendingInstanceId,
    runStop,
    runDeleteAgent,
    deleting,
    runMetaAgent,
    metaAgentLoading,
    handleRestartAgent,
    handleRestartConfirm,
    restartDialogOpen,
    setRestartDialogOpen,
    restartTargetNode,
    selectedRestartInstances,
    setSelectedRestartInstances,
    deleteTarget,
    setDeleteTarget,
  } = useAgentSidebarTree({ orgId, onSelectInstance, onDeleteAgentEnvironments });

  // ---- 渲染 ----

  // 只有首次加载（尚未完成过任何一次数据加载）才显示全屏 loading 动画，判据由 useAgentSidebarTree 维护。
  // 轮询刷新、手动 refresh() 时已有数据保留在 DOM 中，不替换，避免闪烁。
  if (showInitialLoading) {
    return <Spinner variant="panel" size="xs" className="py-6" />;
  }

  // 非加载状态下的空列表
  if ((!treeNodes || treeNodes.length === 0) && !loading) {
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
              "border border-brand/30 rounded-lg bg-gradient-to-r from-brand/5 to-brand/10",
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
              <div className={META_CARD_TITLE_CLASS}>{t("metaAgent")}</div>
              <div className="text-3xs text-text-dim truncate mt-0.5">{t("metaAgentDesc")}</div>
            </div>
          </button>
        </div>
      )}
      {treeNodes.map((node) => {
        const { agent, instances } = node;
        const orderedInstances = orderInstancesByRunningStatus(instances);
        const collapsed = !expandedAgents[agent.id];
        // 通过 entering + enteringTargetId 组合判断具体哪个 agent 正在进入
        const isEntering = entering && enteringTargetId === agent.id;
        const runningInstances = getRunningInstances(node);
        const isAgentSelected =
          node.environment?.id === selectedEnvironmentId ||
          instances.some((inst) => inst.instanceUid === selectedInstanceId);
        // agent 级别的重启中状态：该 agent 下有实例正在重启
        const isRestarting =
          restarting &&
          pendingInstanceId?.type === "restart" &&
          runningInstances.some((inst) => inst.instanceUid === pendingInstanceId?.id);
        const writable = isAgentWritable(agent);
        const displayName = getAgentDisplayName(agent);
        // 拆分 key/名称 格式：前半为标识键，后半为显示名
        const slashIdx = displayName.indexOf("/");
        const agentLabel = slashIdx >= 0 ? displayName.slice(slashIdx + 1) : displayName;
        const agentKey = slashIdx >= 0 ? displayName.slice(0, slashIdx) : "";
        // 访问标签：仅 public/external 展示（internal 不显示徽标）；外部组织判定需要当前组织 id
        const accessBadgeKey = getAgentAccessBadgeKey(agent, orgId);

        return (
          <div key={agent.id} className="agent-sidebar-agent group relative">
            {/* 卡片主体 */}
            <button
              type="button"
              disabled={isEntering}
              onClick={() => runEnter(node)}
              className={[
                "agent-sidebar-agent-card flex items-center justify-between gap-2.5 w-full min-h-10",
                "border border-border-subtle rounded-lg bg-surface-1",
                "cursor-pointer text-left font-[inherit]",
                "transition-all duration-150",
                "hover:bg-surface-hover hover:border-border-default hover:shadow-sm",
                "disabled:opacity-60 disabled:cursor-not-allowed",
                isAgentSelected ? "active" : "",
              ].join(" ")}
            >
              {/* 一行左右布局：左侧显示名（过长截断，title 兜底），右侧标识键 / 远程标记 */}
              <div className="flex items-center gap-1.5 min-w-0">
                <div className={AGENT_ITEM_TITLE_CLASS} title={agentLabel}>
                  {agentLabel}
                </div>
                {/* 仅公有/外部显示标签；色调语义见 `ACCESS_BADGE_TONES` */}
                {accessBadgeKey !== "resource.internal" && (
                  <StatusBadge
                    status={accessBadgeKey}
                    label={tComponents(accessBadgeKey)}
                    toneMap={ACCESS_BADGE_TONES}
                  />
                )}
              </div>
              {/* 副信息：标识键 + 远程标记。`shrink-0` 让名称先让位；键自身再压一个上限，
                  避免长组织名把同一行里的名称挤到只剩几个字 */}
              {(agentKey || shouldShowRemoteNode(agent.agentNode)) && (
                <div className="flex items-center gap-1.5 shrink-0 text-xs text-text-muted">
                  {agentKey && (
                    <span className="font-mono truncate max-w-20" title={agentKey}>
                      {agentKey}
                    </span>
                  )}
                  {shouldShowRemoteNode(agent.agentNode) && (
                    <>
                      <span className="w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0" />
                      <span className="shrink-0">{t("remoteNode")}</span>
                    </>
                  )}
                </div>
              )}
            </button>

            {/* 悬浮操作栏 */}
            <div className="agent-sidebar-actions absolute top-1.5 right-1.5 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                type="button"
                className={AGENT_ACTION_BUTTON_CLASS}
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
                className={AGENT_ACTION_BUTTON_CLASS}
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
                className={AGENT_ACTION_BUTTON_CLASS}
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
                {orderedInstances.length > 0
                  ? orderedInstances.map((inst) => {
                      // per-instance 操作状态：通过 pendingInstanceId 精确匹配实例 ID 和操作类型
                      const isInstRestarting =
                        pendingInstanceId?.id === inst.instanceUid && pendingInstanceId?.type === "restart";
                      const isInstStopping =
                        pendingInstanceId?.id === inst.instanceUid && pendingInstanceId?.type === "stop";
                      return (
                        <div
                          key={inst.instanceUid}
                          className={[
                            "agent-sidebar-instance group flex items-center gap-2 px-3 py-1.5 ml-2 text-xs rounded-md cursor-pointer transition-colors",
                            selectedInstanceId === inst.instanceUid
                              ? "bg-brand-subtle text-brand"
                              : "text-text-primary hover:bg-surface-hover",
                          ].join(" ")}
                          onClick={() => runEnter(node, { instanceUid: inst.instanceUid })}
                        >
                          <StatusDot tone={getInstanceStatusTone(inst)} />
                          <span className="truncate">{inst.name}</span>
                          <div className="ml-auto flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                            <button
                              type="button"
                              className={INSTANCE_ACTION_BUTTON_CLASS}
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
                              className={INSTANCE_ACTION_BUTTON_CLASS}
                              disabled={isInstStopping}
                              onClick={(e) => {
                                e.stopPropagation();
                                runStop(inst.instanceUid);
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
                  className="agent-sidebar-new-instance flex items-center gap-1.5 px-3 py-1 ml-2 text-xs text-text-dim cursor-pointer border-none rounded-md bg-transparent hover:bg-surface-hover hover:text-text-secondary transition-colors whitespace-nowrap"
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
      <AgentSidebarRestartDialog
        open={restartDialogOpen}
        onOpenChange={setRestartDialogOpen}
        restartTargetNode={restartTargetNode}
        selectedRestartInstances={selectedRestartInstances}
        setSelectedRestartInstances={setSelectedRestartInstances}
        onConfirm={handleRestartConfirm}
      />

      {/* 删除智能体确认弹窗 */}
      <AgentSidebarDeleteDialog
        deleteTarget={deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        deleting={deleting}
        onConfirm={runDeleteAgent}
      />
    </div>
  );
});
