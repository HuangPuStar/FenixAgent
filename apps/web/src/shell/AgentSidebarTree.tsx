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
import { Spinner } from "@fenix/ui-components/ui/spinner";
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
import { getInstanceStatus, getRunningInstances, orderInstancesByRunningStatus } from "./agent-sidebar-tree-model";
import { useAgentSidebarTree } from "./use-agent-sidebar-tree";

// 转发排序工具的唯一实现：既有消费方（含 `agent-sidebar-instance-order` 用例）仍从本模块导入。
export { orderInstancesByRunningStatus } from "./agent-sidebar-tree-model";

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
                {(agentKey || shouldShowRemoteNode(agent.agentNode)) && (
                  <div className="text-[10px] text-text-muted truncate flex items-center gap-1.5">
                    {agentKey && <span className="font-mono truncate">{agentKey}</span>}
                    {shouldShowRemoteNode(agent.agentNode) && (
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
                            "agent-sidebar-instance group flex items-center gap-2 px-3 py-1.5 ml-2 text-[13px] rounded-md cursor-pointer transition-colors",
                            selectedInstanceId === inst.instanceUid
                              ? "bg-brand-subtle text-brand"
                              : "text-text-primary hover:bg-surface-hover",
                          ].join(" ")}
                          onClick={() => runEnter(node, { instanceUid: inst.instanceUid })}
                        >
                          <span className={`status-dot ${getInstanceStatus(inst)}`} />
                          <span className="truncate">{inst.name}</span>
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
