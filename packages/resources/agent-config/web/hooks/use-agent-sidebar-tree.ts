/**
 * Agent 侧栏树的数据编排 hook。
 *
 * 迁入自宿主 `apps/web/src/shell/use-agent-sidebar-tree.ts`（2026-09-28）：侧栏树列的是 agent 配置与
 * 它的实例，取数与四种领域操作（进入 / 重启 / 停止 / 删除）本就属 agent 域，留在壳里违反前端规范
 * §2.5「壳不做取数」。迁入后宿主只留接线（选中实例的回调、删除环境后的清理），失败提示与重试都在本包。
 * 视图侧 UI 状态（树展开）刻意留在 `@fenix/ui-components` 的 `AgentTree` 内：它只影响渲染。
 *
 * 职责（内容与迁移前逐字一致）：
 * - 15s 轮询加载 agent 树并维护 `environmentId → agentConfigId` 映射（删除智能体时用它清理环境）；
 * - 四组 mutation（进入 / 重启 / 停止 / 删除智能体），失败语义与 toast 文案不变；
 * - 多实例重启所需的会话状态与编排（是否弹窗、选中集合、逐个重启）。
 *
 * 环境与实例经 `@fenix/agent-runtime` 的两条窄口取用：`web/api/environments`（既有例外）与
 * `web/api/instances`（本次随树迁入新增，见包 `web/__tests__/agent-config-browser-surface.test.ts`）。
 */
import {
  type EnvironmentDetail,
  type EnvironmentInstanceInfo,
  envApi,
} from "@fenix/agent-runtime/web/api/environments";
import { instanceApi } from "@fenix/agent-runtime/web/api/instances";
import { getRunningInstances } from "@fenix/ui-components/agent-tree/agent-tree-model";
import { unwrap } from "@fenix/web-runtime/api/request";
import { dispatchConfigChange, useConfigChangeListener } from "@fenix/web-runtime/lib/config-events";
import type { AgentInfo } from "@fenix/web-runtime/types/config";
import { useRequest } from "ahooks";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { agentApi } from "../api/agents";
import { AGENTS_NS } from "../i18n/namespace";

/** 树节点：一个 agent 配置 + 它当前绑定的环境与实例。 */
export interface AgentSidebarTreeNode {
  agent: AgentInfo;
  environment: EnvironmentDetail | null;
  instances: EnvironmentInstanceInfo[];
}

interface UseAgentSidebarTreeOptions {
  /** 当前组织 id；未就绪时保持 `ready: false`，不发起请求。 */
  orgId: string | undefined;
  /**
   * 选中实例的回调。第三个形参虽然叫 `sessionId`（沿用宿主路由段与 `DefaultAppShell` 的既有叫法），
   * 实际传的是 **instanceUid**；`null` 表示只到 agent 级路由。理由见 `runEnter` 调用点。
   */
  onSelectInstance: (instanceId: string, envId: string, sessionId: string | null) => void;
  /** 删除智能体后回调被一并清理的环境 id，宿主用它把已删除环境的聊天面板收起。 */
  onDeleteAgentEnvironments?: (environmentIds: string[]) => void;
}

export function useAgentSidebarTree({
  orgId,
  onSelectInstance,
  onDeleteAgentEnvironments,
}: UseAgentSidebarTreeOptions) {
  const { t } = useTranslation(AGENTS_NS);

  // 多实例重启选择弹窗状态
  const [restartDialogOpen, setRestartDialogOpen] = useState(false);
  const [restartTargetNode, setRestartTargetNode] = useState<AgentSidebarTreeNode | null>(null);
  const [selectedRestartInstances, setSelectedRestartInstances] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<AgentInfo | null>(null);

  // 进入/重启/停止操作的标识追踪：记录正在操作的目标及操作类型
  const [enteringTargetId, setEnteringTargetId] = useState<string | null>(null);
  const [pendingInstanceId, setPendingInstanceId] = useState<{ id: string; type: "restart" | "stop" } | null>(null);

  // environmentId → agentConfigId 映射：用于判断当前对话页打开的环境属于哪个 agent 配置。
  // 相比 treeNodes 每个 agent 只保留单个环境，这里覆盖全部环境，避免多环境场景漏判。
  const envConfigMapRef = useRef<Map<string, string>>(new Map());

  // 跟踪首次加载是否已完成。用于避免轮询刷新时替换已有 UI，消除闪烁。
  const initialLoadDoneRef = useRef(false);

  // ---- 数据加载（带 15s 轮询）----
  const {
    data: treeNodes = [],
    loading,
    refresh,
  } = useRequest(
    async (): Promise<AgentSidebarTreeNode[]> => {
      const [agentsResult, envs] = await Promise.all([unwrap(agentApi.list()), unwrap(envApi.list())]);

      const agents = Array.isArray(agentsResult.agents) ? agentsResult.agents : [];

      // 过滤内置智能体
      const userAgents = agents.filter((agent) => !agent.builtIn);

      // 建立 agentConfigId → environment 映射
      const envByConfigId = new Map<string, EnvironmentDetail>();
      // 同步刷新 environmentId → agentConfigId 全量映射（含同一 agent 的多个环境）
      const envConfigMap = new Map<string, string>();
      for (const env of envs) {
        const configId = env.agentConfigId;
        if (configId) {
          envByConfigId.set(configId, env);
          if (env.id) envConfigMap.set(env.id, configId);
        }
      }
      envConfigMapRef.current = envConfigMap;

      // 构建 tree nodes
      const nodes: AgentSidebarTreeNode[] = userAgents.map((agent) => ({
        agent,
        environment: envByConfigId.get(agent.id) ?? null,
        instances: [],
      }));

      // 加载有活跃实例的 environment 的 instances
      const activeEnvs = envs.filter((env) => (env.instancesCount ?? 0) > 0);
      if (activeEnvs.length > 0) {
        const results = await Promise.allSettled(activeEnvs.map((env) => unwrap(envApi.listInstances({ id: env.id }))));
        const instMap: Record<string, EnvironmentInstanceInfo[]> = {};
        activeEnvs.forEach((env, i) => {
          const result = results[i];
          if (result.status === "fulfilled") {
            instMap[env.id] = result.value.instances ?? [];
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
    {
      pollingInterval: 15_000,
      refreshDeps: [orgId],
      ready: !!orgId,
      loadingDelay: 300,
      onSuccess: () => {
        initialLoadDoneRef.current = true;
      },
    },
  );

  // 监听配置变更事件，agents 变更时立即刷新
  useConfigChangeListener(
    (module) => {
      if (module === "agents") refresh();
    },
    [refresh],
  );

  // 首次加载尚未完成时视图才允许用全屏 loading 替换内容；轮询与手动 refresh 保持已有数据。
  const showInitialLoading = loading && !initialLoadDoneRef.current;

  // ---- 进入智能体（manual useRequest）----
  const { run: runEnter, loading: entering } = useRequest(
    async (node: AgentSidebarTreeNode, opts?: { instanceUid?: string; spawnNew?: boolean }) => {
      const { agent, environment } = node;
      const { instanceUid, spawnNew } = opts ?? {};
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

      let enterResult: { instanceUid: string; environmentId: string };

      if (spawnNew) {
        const spawned = await unwrap(instanceApi.spawn({ environmentId: envId }));
        enterResult = await unwrap(envApi.enter({ id: envId }, { instanceUid: spawned.instanceUid }));
      } else {
        enterResult = await unwrap(envApi.enter({ id: envId }, instanceUid ? { instanceUid } : undefined));
      }

      // 第三个实参是 **instanceUid**，不是 DB/ACP 会话 id（形参名 `sessionId` 是历史遗留叫法）。
      // 该值落到宿主 URL 段 `/agent/chat/{environmentId}/{instanceUid}`，下游有两处硬约束：
      //   ① `use-chat-panel-runtime` 把它当 WS query 的 `instanceUid`，服务端 `routes/acp/index.ts`
      //      用 `createDeterministicRcsSessionId(agentId, userId, instanceUid)` 反推期望的 rcsSessionId，
      //      不一致直接以 4003 关闭——所以派生前缀只能是 instanceUid，客户端与它同源才连得上；
      //   ② 侧边栏以 `inst.instanceUid === selectedInstanceId` 判定高亮。
      // YJS doc 隔离与刷新可达性因此都由 instanceUid 承担：不同实例 = 不同 rcsSessionId = 不同 Doc；
      // 刷新带回同一 instanceUid 即回到同一份 Doc。改传 DB 会话 id 会让 ① 的实例定位失效、② 全部失配。
      onSelectInstance(enterResult.instanceUid, enterResult.environmentId ?? envId, enterResult.instanceUid);

      // 刷新列表以展示新实例
      refresh();
    },
    {
      manual: true,
      onFinally: () => setEnteringTargetId(null),
      onError: (err) => {
        // 四个 mutation 的失败提示统一只上屏本包的字典文案：`err.message` 是 `unwrap` 抛出的
        // `ApiError.message`，即后端错误信封原文；原始 error 对象仍进 `console.error` 保诊断上下文。
        console.error("Failed to enter instance:", err);
        toast.error(t("enterFailed"));
      },
    },
  );

  // ---- 重启实例（manual useRequest）----
  const { run: runRestart, loading: restarting } = useRequest(
    async (node: AgentSidebarTreeNode, instance: EnvironmentInstanceInfo) => {
      const envId = node.environment?.id;
      if (!envId) throw new Error("No environment found for restart");

      setPendingInstanceId({ id: instance.instanceUid, type: "restart" });

      await unwrap(instanceApi.restart({ id: instance.instanceUid }));

      // 通知 ChatPanel 重新连接（事件名是聊天容器与本模块之间的既有契约，改名要同批改消费方）
      window.dispatchEvent(new window.CustomEvent("agent:reconnect", { detail: { envId } }));

      await refresh();
      toast.success(t("restartSuccess"));
    },
    {
      manual: true,
      onFinally: () => setPendingInstanceId(null),
      onError: (err) => {
        console.error("Failed to restart instance:", err);
        toast.error(t("restartFailed"));
      },
    },
  );

  // ---- 停止实例（manual useRequest）----
  const { run: runStop, loading: _stopping } = useRequest(
    async (instanceId: string) => {
      setPendingInstanceId({ id: instanceId, type: "stop" });

      await unwrap(instanceApi.stop({ id: instanceId }));
      await refresh();
      toast.success(t("stopSuccess"));
    },
    {
      manual: true,
      onFinally: () => setPendingInstanceId(null),
      onError: (err) => {
        console.error("Failed to stop instance:", err);
        toast.error(t("stopInstanceFailed"));
      },
    },
  );

  // ---- 删除智能体（manual useRequest）----
  const { run: runDeleteAgent, loading: deleting } = useRequest(
    async (agent: AgentInfo) => {
      const deletingEnvironmentIds = [...envConfigMapRef.current.entries()]
        .filter(([, agentConfigId]) => agentConfigId === agent.id)
        .map(([environmentId]) => environmentId);

      await unwrap(agentApi.delete(agent.name));
      toast.success(t("deleteSuccess"));
      onDeleteAgentEnvironments?.(deletingEnvironmentIds);

      // 通知其它页面（如智能体管理页）刷新列表
      dispatchConfigChange("agents");
      await refresh();
    },
    {
      manual: true,
      onFinally: () => setDeleteTarget(null),
      onError: (err) => {
        console.error("Failed to delete agent:", err);
        toast.error(t("deleteFailed"));
      },
    },
  );

  // ---- 批量重启辅助函数 ----
  const handleRestartAgent = (node: AgentSidebarTreeNode) => {
    const running = getRunningInstances(node.instances);
    if (running.length === 0) {
      toast.info(t("noInstancesToRestart"));
      return;
    }
    if (running.length === 1) {
      runRestart(node, running[0]);
      return;
    }
    setRestartTargetNode(node);
    setSelectedRestartInstances(new Set(running.map((instance) => instance.instanceUid)));
    setRestartDialogOpen(true);
  };

  const handleRestartConfirm = async () => {
    if (!restartTargetNode) return;
    const running = getRunningInstances(restartTargetNode.instances);
    const targets = running.filter((instance) => selectedRestartInstances.has(instance.instanceUid));
    setRestartDialogOpen(false);
    // 逐个重启选中实例；onError 已处理 toast 通知
    for (const instance of targets) {
      try {
        await runRestart(restartTargetNode, instance);
      } catch {
        // onError 已弹出 toast，此处仅阻止异常中断循环
      }
    }
    setRestartTargetNode(null);
  };

  return {
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
    handleRestartAgent,
    handleRestartConfirm,
    restartDialogOpen,
    setRestartDialogOpen,
    restartTargetNode,
    selectedRestartInstances,
    setSelectedRestartInstances,
    deleteTarget,
    setDeleteTarget,
  };
}
