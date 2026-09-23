/**
 * Agent 侧边栏树的数据编排 hook。
 *
 * 从 `AgentSidebarTree.tsx` 拆出的第二层（§4.7 文件规模）：负责"树的数据从哪来、操作怎么发出去"，
 * 只向视图暴露数据与操作句柄，不含任何 JSX。内容与拆分前逐字一致：
 *
 * - 15s 轮询加载 agent 树并维护 `environmentId → agentConfigId` 映射（删除智能体时用它清理环境）；
 * - 四组 mutation（进入 / 重启 / 停止 / 删除智能体），失败语义与 toast 文案不变；
 * - 多实例重启所需的会话状态与编排（是否弹窗、选中集合、逐个重启）。
 *
 * 视图侧 UI 状态（树展开）刻意留在组件内：它们只影响渲染，与数据来源无关。
 */
import { agentApi } from "@fenix/agent-config/web";
import { envApi } from "@fenix/agent-runtime/web/api/environments";
import { unwrap } from "@fenix/web-runtime/api/request";
import { dispatchConfigChange, useConfigChangeListener } from "@fenix/web-runtime/lib/config-events";
import { useRequest } from "ahooks";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { instanceApi } from "@/src/api/instances";
import { NS } from "@/src/i18n";
import type { Environment, EnvironmentInstance } from "../types/index";
import { type AgentConfigItem, type AgentTreeNode, getRunningInstances } from "./agent-sidebar-tree-model";

interface UseAgentSidebarTreeOptions {
  /** 当前组织 id；未就绪时保持 `ready: false`，不发起请求。 */
  orgId: string | undefined;
  /**
   * 选中实例的回调。第三个形参虽然叫 `sessionId`（沿用 `DefaultAppShell` 与路由段 `$sessionId` 的
   * 既有叫法），实际传的是 **instanceUid**；`null` 表示只到 agent 级路由。理由见 `runEnter` 调用点。
   */
  onSelectInstance: (instanceId: string, envId: string, sessionId: string | null) => void;
  onDeleteAgentEnvironments?: (environmentIds: string[]) => void;
}

export function useAgentSidebarTree({
  orgId,
  onSelectInstance,
  onDeleteAgentEnvironments,
}: UseAgentSidebarTreeOptions) {
  const { t } = useTranslation(NS.AGENT_PANEL);

  // 多实例重启选择弹窗状态
  const [restartDialogOpen, setRestartDialogOpen] = useState(false);
  const [restartTargetNode, setRestartTargetNode] = useState<AgentTreeNode | null>(null);
  const [selectedRestartInstances, setSelectedRestartInstances] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<AgentConfigItem | null>(null);

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
    async (node: AgentTreeNode, opts?: { instanceUid?: string; spawnNew?: boolean }) => {
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
      // 该值落到 URL 段 `/agent/chat/{environmentId}/{instanceUid}`，下游有两处硬约束：
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

      setPendingInstanceId({ id: instance.instanceUid, type: "restart" });

      await unwrap(instanceApi.restart({ id: instance.instanceUid }));

      // 通知 ChatPanel 重新连接
      window.dispatchEvent(new window.CustomEvent("agent:reconnect", { detail: { envId } }));

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

      await unwrap(instanceApi.stop({ id: instanceId }));
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
        toast.error(t("deleteFailed", { message: (err as Error).message }));
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
    setSelectedRestartInstances(new Set(running.map((i) => i.instanceUid)));
    setRestartDialogOpen(true);
  };

  const handleRestartConfirm = async () => {
    if (!restartTargetNode) return;
    const running = getRunningInstances(restartTargetNode);
    const targets = running.filter((inst) => selectedRestartInstances.has(inst.instanceUid));
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
