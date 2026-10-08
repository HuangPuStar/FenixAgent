/**
 * Agent 侧栏树容器：宿主左侧栏的智能体区。
 *
 * 三层分工（前端规范 §3.5）：`useAgentSidebarTree`（取数与领域操作）↔ 本容器（领域对象 → 视图模型、
 * 弹窗装配）↔ `@fenix/ui-components` 的 `AgentTree`（纯渲染）。本容器是唯一知道「agent 的哪些字段
 * 要喂给视图」的地方：显示名、访问角标、可写可删都由 `web/lib/agent-resource-access` 判完再传下去，
 * 组件库因此不依赖任何 `@fenix/*` 包，也不需要认识 `AgentInfo`。
 *
 * 组织上下文取 `useOrgSession()`（资源包唯一合法读法，§3.3）：角标要判「是否外部组织资源」，
 * 轮询要等组织就绪。宿主壳过去用 `useOrg()` 读同一个值——那是身份包的富上下文，只准壳与身份包自用。
 */
import type { EnvironmentInstanceInfo } from "@fenix/agent-runtime/web/api/environments";
import { AgentTree } from "@fenix/ui-components/agent-tree/agent-tree";
import { type AgentTreeAgentItem, getRunningInstances } from "@fenix/ui-components/agent-tree/agent-tree-model";
import { useOrgSession } from "@fenix/web-runtime/contexts/org-session";
import { useCallback, useMemo } from "react";
import { type AgentSidebarTreeNode, useAgentSidebarTree } from "../../hooks/use-agent-sidebar-tree";
import { shouldShowRemoteNode } from "../../lib/agent-node";
import {
  getAgentAccessBadgeKey,
  getAgentConfigLookupKey,
  getAgentDisplayName,
  isAgentWritable,
} from "../../lib/agent-resource-access";
import { AgentSidebarDeleteDialog, AgentSidebarRestartDialog } from "./agent-sidebar-tree-dialogs";

interface AgentSidebarTreeProps {
  selectedInstanceId?: string | null;
  selectedEnvironmentId?: string | null;
  /** 选中实例（进入某个 agent / 实例后由宿主导航到聊天路由）。第三参是 instanceUid，见 hook 注释。 */
  onSelectInstance: (instanceId: string, envId: string, sessionId: string | null) => void;
  onCreateAgent?: () => void;
  /** 打开 agent 配置；参数是跨组织稳定查找键（`getAgentConfigLookupKey`）。 */
  onEditAgent?: (agentName: string) => void;
  /** 删除智能体后回调被清理的环境 id（宿主据此收起已删除环境的聊天面板）。 */
  onDeleteAgentEnvironments?: (environmentIds: string[]) => void;
}

export function AgentSidebarTree({
  selectedInstanceId = null,
  selectedEnvironmentId = null,
  onSelectInstance,
  onCreateAgent,
  onEditAgent,
  onDeleteAgentEnvironments,
}: AgentSidebarTreeProps) {
  const { organizationId } = useOrgSession();
  const orgId = organizationId ?? undefined;

  const {
    treeNodes,
    loading,
    showInitialLoading,
    runEnter,
    enteringTargetId,
    runRestart,
    pendingInstanceId,
    runStop,
    runDeleteAgent,
    deleting,
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

  // agent 配置 id → 树节点：视图回调只带 id（组件库不认识领域节点），领域侧据此查回环境与实例。
  const nodeById = useMemo(() => new Map(treeNodes.map((node) => [node.agent.id, node])), [treeNodes]);

  const agents = useMemo<AgentTreeAgentItem[]>(
    () =>
      treeNodes.map((node) => {
        const writable = isAgentWritable(node.agent);
        return {
          id: node.agent.id,
          displayName: getAgentDisplayName(node.agent),
          accessBadgeKey: getAgentAccessBadgeKey(node.agent, orgId),
          readOnly: !writable,
          // 内置 agent 不提供删除入口（与编辑器一致：它们由平台维护）
          deletable: writable && !node.agent.builtIn,
          remote: shouldShowRemoteNode(node.agent.agentNode),
          environmentId: node.environment?.id ?? null,
          instances: node.instances,
        };
      }),
    [treeNodes, orgId],
  );

  const withNode = useCallback(
    (agentId: string, action: (node: AgentSidebarTreeNode) => void) => {
      const node = nodeById.get(agentId);
      if (node) action(node);
    },
    [nodeById],
  );

  const handleEnterAgent = useCallback(
    (agentId: string) => withNode(agentId, (node) => runEnter(node)),
    [runEnter, withNode],
  );
  const handleEnterInstance = useCallback(
    (agentId: string, instanceUid: string) => withNode(agentId, (node) => runEnter(node, { instanceUid })),
    [runEnter, withNode],
  );
  const handleSpawnInstance = useCallback(
    (agentId: string) => withNode(agentId, (node) => runEnter(node, { spawnNew: true })),
    [runEnter, withNode],
  );
  const handleRestart = useCallback(
    (agentId: string) => withNode(agentId, (node) => handleRestartAgent(node)),
    [handleRestartAgent, withNode],
  );
  const handleRestartInstance = useCallback(
    (agentId: string, instanceUid: string) =>
      withNode(agentId, (node) => {
        const instance = node.instances.find((item) => item.instanceUid === instanceUid);
        if (instance) runRestart(node, instance);
      }),
    [runRestart, withNode],
  );
  const handleStopInstance = useCallback((instanceUid: string) => runStop(instanceUid), [runStop]);
  const handleConfigureAgent = useCallback(
    (agentId: string) => withNode(agentId, (node) => onEditAgent?.(getAgentConfigLookupKey(node.agent))),
    [onEditAgent, withNode],
  );
  const handleDeleteAgent = useCallback(
    (agentId: string) => withNode(agentId, (node) => setDeleteTarget(node.agent)),
    [setDeleteTarget, withNode],
  );

  // 重启弹窗只列「可重启」实例（running / starting），与 `handleRestartAgent` 的判据同源：
  // 同一个 `getRunningInstances` 既决定「弹不弹窗」，也决定弹窗里有什么，不会出现弹窗列出却重启不了的行。
  const restartInstances: EnvironmentInstanceInfo[] = useMemo(
    () => (restartTargetNode ? getRunningInstances(restartTargetNode.instances) : []),
    [restartTargetNode],
  );

  return (
    <>
      <AgentTree
        agents={agents}
        initialLoading={showInitialLoading}
        fetching={loading}
        selectedInstanceId={selectedInstanceId}
        selectedEnvironmentId={selectedEnvironmentId}
        enteringAgentId={enteringTargetId}
        pendingInstance={pendingInstanceId}
        onCreateAgent={onCreateAgent}
        onEnterAgent={handleEnterAgent}
        onEnterInstance={handleEnterInstance}
        onSpawnInstance={handleSpawnInstance}
        onRestartAgent={handleRestart}
        onRestartInstance={handleRestartInstance}
        onStopInstance={handleStopInstance}
        onConfigureAgent={handleConfigureAgent}
        onDeleteAgent={handleDeleteAgent}
      />

      {/* 多实例重启选择弹窗 */}
      <AgentSidebarRestartDialog
        open={restartDialogOpen}
        onOpenChange={setRestartDialogOpen}
        restartInstances={restartInstances}
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
    </>
  );
}
