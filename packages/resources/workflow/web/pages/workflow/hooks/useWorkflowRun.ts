import { unwrap } from "@fenix/web-runtime/api/request";
import type { Edge, Node } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { workflowDefApi } from "../../../api/workflow-defs";
import {
  type DAGSnapshot,
  type NodeOutput,
  type PendingApproval,
  workflowEngineApi,
} from "../../../api/workflow-engine";
import type { WorkflowSSEEvent } from "../../../api/workflow-sse";
import { pushWorkflowError } from "../../../lib/use-workflow-events";
import { autoLayout } from "../layout";
import { applySnapshotToNodes, clearRunMarkers, isTerminalDagStatus } from "../run-canvas-model";
import { type RunViewSetters, resetRunView } from "../run-view";
import { dedupEvents } from "../utils";
import { useWorkflowRunLifecycle } from "./use-workflow-run-lifecycle";
import { useWorkflowRunTransport } from "./use-workflow-run-transport";

/**
 * 工作流编辑器的**运行视图编排**：向外提供运行视图所需的全部命令与状态，向内装配三层。
 *
 * 拆分后的分工（按 §3.5 的三层）：
 * - 纯模型 `../run-canvas-model.ts`：画布节点运行标记的写入 / 清除；
 * - 传输适配 `./use-workflow-run-transport.ts`：轮询、待审批、节点输出三处取数与回写（该文件头说明了
 *   为什么仍不换成 `useRequest`）；
 * - 生命周期命令 `./use-workflow-run-lifecycle.ts`：发起运行 / 取消 / 审批 / 重跑；
 * - 本文件：dry-run、退出运行视图、节点输出入口、刷新草稿、SSE 事件分发、从运行记录回放（路由带 `runId`），
 *   以及上面三层的装配。留下来的都是「需要同时看运行态、画布数据与编辑时机」的部分。
 *
 * 注意状态归属：`activeRunId` / `runSnapshot` / `runEvents` / `runApprovals` / `selectedRunNodeId` /
 * `selectedNodeOutput` / `nodeOutputLoading` 由 `WorkflowEditor` 顶层持有（`RunStatusPanel` 也会写它们），
 * 本 hook 只按 §3.4 的口径读写，不接管所有权。
 */
export interface UseWorkflowRunParams {
  workflowId: string | undefined;
  /** 路由带来的运行 id：从运行记录进入编辑器时回放那一次运行 */
  runId?: string;
  nodes: Node[];
  edges: Edge[];
  setNodes: ReturnType<typeof import("@xyflow/react").useNodesState<Node>>[1];
  setEdges: ReturnType<typeof import("@xyflow/react").useEdgesState<Edge>>[1];
  activeRunId: string | null;
  setActiveRunId: (id: string | null) => void;
  runSnapshot: DAGSnapshot | null;
  setRunSnapshot: (snap: DAGSnapshot | null) => void;
  setRunEvents: (events: import("../../../api/workflow-engine").DAGEvent[]) => void;
  setRunApprovals: (approvals: PendingApproval[]) => void;
  selectedRunNodeId: string | null;
  setSelectedRunNodeId: (id: string | null) => void;
  selectedNodeOutput: NodeOutput | null;
  setSelectedNodeOutput: (output: NodeOutput | null) => void;
  nodeOutputLoading: boolean;
  setNodeOutputLoading: (loading: boolean) => void;
  syncYaml: () => string;
  fitView: (opts?: { padding?: number; duration?: number }) => void;
  /** dry-run 结果由编辑器顶层持有（它同时被 SSE / 提示层读取，见 WorkflowEditor 的状态归属说明） */
  setDryRunResult: (
    result: { valid: boolean; issues: Array<{ type: string; message: string; field?: string }> } | null,
  ) => void;
  openRunSheet: () => void;
  /** 回放时只打开运行抽屉，不动版本 / 触发器 Sheet（与 openRunSheet 的差别） */
  setRunSheetOpen: (open: boolean) => void;
  setMeta: (fn: (prev: import("../yaml-utils").WfMeta) => import("../yaml-utils").WfMeta) => void;
  lastSavedYaml: string;
  setLastSavedYaml: (yaml: string) => void;
  meta: import("../yaml-utils").WfMeta;
}

export interface UseWorkflowRunReturn {
  handleDryRun: () => Promise<void>;
  handleRun: (params?: Record<string, unknown>) => Promise<void>;
  handleCancelRun: () => Promise<void>;
  handleApprove: (approval: PendingApproval) => Promise<void>;
  handleBackToEdit: () => void;
  handleBackToList: () => void;
  handleRerunFrom: (nodeId: string) => Promise<void>;
  handleViewNodeOutput: (nodeId: string) => void;
  handleRefreshDraft: () => Promise<void>;
  running: boolean;
  isRunMode: boolean;
  isRunDone: boolean;
  dagStatus: string | undefined;
  runRightTab: "events" | "output";
  setRunRightTab: (tab: "events" | "output") => void;
  updateNodesFromSnapshot: (snap: DAGSnapshot) => void;
  loadRunData: (runId: string) => Promise<void>;
  clearDryRunResult: () => void;
  handleWorkflowEvent: (event: WorkflowSSEEvent) => void;
  pollRef: React.MutableRefObject<ReturnType<typeof setInterval> | null>;
}

export function useWorkflowRun(params: UseWorkflowRunParams): UseWorkflowRunReturn {
  const {
    workflowId,
    runId,
    edges,
    setNodes,
    setEdges,
    activeRunId,
    setActiveRunId,
    runSnapshot,
    setRunSnapshot,
    setRunEvents,
    setRunApprovals,
    selectedRunNodeId,
    setSelectedRunNodeId,
    selectedNodeOutput: _selectedNodeOutput,
    setSelectedNodeOutput,
    nodeOutputLoading: _nodeOutputLoading,
    setNodeOutputLoading,
    syncYaml,
    fitView,
    setDryRunResult,
    openRunSheet,
    setRunSheetOpen,
    setMeta,
    lastSavedYaml: _lastSavedYaml,
    setLastSavedYaml,
    meta,
  } = params;

  const { t } = useTranslation("workflows");

  // 运行视图态的 setter 打包一次，供 5 处复位共用（定义与理由见 ../run-view.ts）
  const runViewSetters: RunViewSetters = useMemo(
    () => ({ setRunSnapshot, setRunEvents, setRunApprovals, setSelectedRunNodeId, setSelectedNodeOutput }),
    [setRunSnapshot, setRunEvents, setRunApprovals, setSelectedRunNodeId, setSelectedNodeOutput],
  );

  const nodeCallbacksRef = useRef<{
    onViewOutput: (nodeId: string) => void;
    onRerunFrom: (fromNodeId: string) => void;
  }>({ onViewOutput: () => {}, onRerunFrom: () => {} });

  const [running, setRunning] = useState(false);
  const [runRightTab, setRunRightTab] = useState<"events" | "output">("events");

  const isRunMode = activeRunId !== null;
  const dagStatus = runSnapshot?.dag_status;
  const isRunDone = isTerminalDagStatus(dagStatus);

  const handleDryRun = useCallback(async () => {
    const y = syncYaml();
    setRunning(true);
    setDryRunResult(null);
    try {
      const result = await unwrap(workflowEngineApi.dryRun(y));
      setDryRunResult(result);
    } catch (err) {
      console.error(err);
      pushWorkflowError(workflowId, "validation", (err as Error).message);
      setDryRunResult({ valid: false, issues: [{ type: "error", message: (err as Error).message }] });
    } finally {
      setRunning(false);
    }
  }, [syncYaml, workflowId, setDryRunResult]);

  const updateNodesFromSnapshot = useCallback(
    (snap: DAGSnapshot) => {
      setNodes((nds) => applySnapshotToNodes(nds, snap, nodeCallbacksRef.current));
    },
    [setNodes],
  );

  const updateNodesFromSnapshotRef = useRef(updateNodesFromSnapshot);
  updateNodesFromSnapshotRef.current = updateNodesFromSnapshot;

  /**
   * 从运行记录进入编辑器（路由带 runId）＝回放那一次运行：进入运行视图并装入它的快照与事件。
   *
   * 与传输层的 `loadRunData` 的差别：回放**不**推 `pushWorkflowRunStatus`（那会给一次历史回放追加运行
   * 状态事件，而用户并没有在跑它）；其余取数口径一致。回放也只打开运行抽屉，不动版本 / 触发器 Sheet。
   */
  useEffect(() => {
    if (!runId) return;
    let abort = false;
    (async () => {
      try {
        setActiveRunId(runId);
        resetRunView(runViewSetters);
        setRunSheetOpen(true);

        const [snap, evts] = await Promise.all([
          unwrap(workflowEngineApi.getRunStatus(runId)),
          unwrap(workflowEngineApi.getEvents(runId)),
        ]);
        if (abort) return;
        if (snap) {
          setRunSnapshot(snap);
          updateNodesFromSnapshotRef.current(snap);
        }
        if (Array.isArray(evts)) setRunEvents(dedupEvents(evts));
      } catch (err) {
        console.error(`${t("editor.load_run_failed")}:`, err);
        // 从运行记录进入编辑器时，这一拉是运行面板的唯一数据源：失败必须让用户知道面板是空的
        toast.error(t("editor.load_run_failed"));
      }
    })();
    return () => {
      abort = true;
    };
  }, [runId, t, setActiveRunId, runViewSetters, setRunSheetOpen, setRunSnapshot, setRunEvents]);

  const { loadRunData, pollRef } = useWorkflowRunTransport({
    workflowId,
    activeRunId,
    runSnapshot,
    selectedRunNodeId,
    setRunSnapshot,
    setRunEvents,
    setRunApprovals,
    setSelectedNodeOutput,
    setNodeOutputLoading,
    setRunRightTab,
    setRunning,
    applySnapshotRef: updateNodesFromSnapshotRef,
  });

  /** 解析 meta.params 中的默认值，生成运行时 params */
  const resolveDefaultParams = useCallback((): Record<string, unknown> | undefined => {
    const paramsDef = meta.params as Record<string, Record<string, unknown>> | undefined;
    if (!paramsDef || Object.keys(paramsDef).length === 0) return;
    const resolved: Record<string, unknown> = {};
    for (const [key, def] of Object.entries(paramsDef)) {
      if (def && typeof def === "object" && "default" in def && def.default !== undefined) {
        resolved[key] = def.default;
      }
    }
    return Object.keys(resolved).length > 0 ? resolved : undefined;
  }, [meta.params]);

  const { handleRun, handleCancelRun, handleApprove, handleRerunFrom } = useWorkflowRunLifecycle({
    workflowId,
    edges,
    activeRunId,
    setActiveRunId,
    setNodes,
    setRunning,
    setDryRunResult,
    setRunApprovals,
    syncYaml,
    resolveDefaultParams,
    pollRef,
    runViewSetters,
    openRunSheet,
    loadRunData,
  });

  /**
   * 退出运行视图：停轮询、复位运行态、清 dry-run 结果，并摘掉画布节点上的运行标记。
   *
   * 「回到编辑」（面板头部的编辑按钮）与「回到运行列表」（返回箭头）要复位的东西**逐字相同**
   * ——2026-09-22 去重，此前是两个各 18 行的副本。两者的差别只在调用方，不在复位内容：
   * 编辑器在「回到编辑」之后额外关掉运行抽屉（`WorkflowEditor` 的包装），返回列表则直接用。
   * 因此这里只留一份实现，两个对外名字都指向它；新增一个「退出运行视图要清什么」的字段时只改这一处。
   */
  const handleExitRunView = useCallback(() => {
    if (pollRef.current) clearTimeout(pollRef.current);
    setRunning(false);
    setActiveRunId(null);
    resetRunView(runViewSetters);
    setDryRunResult(null);
    setNodes((nds) => clearRunMarkers(nds));
  }, [setActiveRunId, runViewSetters, setNodes, pollRef, setDryRunResult]);

  const handleBackToEdit = handleExitRunView;
  const handleBackToList = handleExitRunView;

  const handleViewNodeOutput = useCallback(
    async (nodeId: string) => {
      if (!activeRunId) return;
      setSelectedRunNodeId(nodeId);
      setRunRightTab("output");
      setNodeOutputLoading(true);
      setSelectedNodeOutput(null);
      openRunSheet();
      try {
        const out = await unwrap(workflowEngineApi.getOutput(activeRunId, nodeId));
        setSelectedNodeOutput(out ?? null);
      } catch (err) {
        console.error(err);
        setSelectedNodeOutput(null);
      } finally {
        setNodeOutputLoading(false);
      }
    },
    [activeRunId, setSelectedRunNodeId, setNodeOutputLoading, setSelectedNodeOutput, openRunSheet],
  );

  nodeCallbacksRef.current.onViewOutput = handleViewNodeOutput;
  nodeCallbacksRef.current.onRerunFrom = handleRerunFrom;

  /**
   * 刷新草稿：重读服务端草稿并落画布，若正在运行则把快照重新贴回节点。
   *
   * 与草稿加载（`WorkflowEditor` 里 workflowId 切换、版本预览切回草稿）的落画布逻辑**刻意不合并**：
   * 那两处还要 setWfData、处理名称与描述，且不重贴运行快照；这里多一步运行快照重贴（否则草稿刷新后
   * 画布节点状态会与真实运行状态不一致），少几步元数据覆盖。共同部分只有「yamlToFlow → 计数器同步 →
   * autoLayout → 落画布」四行，合并会把差异藏进参数（与 §4.8 对三种节点配置容器的裁定同一口径）。
   */
  const handleRefreshDraft = useCallback(async () => {
    if (!workflowId) return;
    if (isRunMode && !isRunDone) return;
    const { syncEdgeCounter, syncNodeCounter, yamlToFlow } = await import("../yaml-utils");
    try {
      const wf = await unwrap(workflowDefApi.get(workflowId));
      if (wf.draftYaml) {
        const { nodes: newNodes, edges: newEdges, meta: newMeta } = yamlToFlow(wf.draftYaml);
        syncNodeCounter(newNodes.map((n) => n.id));
        syncEdgeCounter(newEdges.map((e) => e.id));
        setNodes(autoLayout(newNodes, newEdges));
        setEdges(newEdges);
        setMeta(() => newMeta);
        setLastSavedYaml(wf.draftYaml);
        if (activeRunId) {
          try {
            const snap = await unwrap(workflowEngineApi.getRunStatus(activeRunId));
            if (snap) updateNodesFromSnapshotRef.current(snap);
          } catch (err) {
            console.error(`${t("editor.restore_run_failed")}:`, err);
            // 草稿已刷新成功，但运行状态没跟上，画布上的节点状态会与真实运行状态不一致
            toast.error(t("editor.restore_run_failed"));
          }
        }
        setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 50);
      }
    } catch (err) {
      console.error(`${t("editor.refresh_failed")}:`, err);
      // 用户点了刷新却什么都没变，必须给出可见反馈
      toast.error(t("editor.refresh_failed"));
    }
  }, [workflowId, isRunMode, isRunDone, activeRunId, setNodes, setEdges, setMeta, setLastSavedYaml, fitView, t]);

  const clearDryRunResult = useCallback(() => setDryRunResult(null), [setDryRunResult]);

  const handleWorkflowEvent = useCallback(
    (event: WorkflowSSEEvent) => {
      switch (event.type) {
        case "workflow.run_started": {
          const runId = event.runId as string;
          if (runId && runId !== activeRunId) {
            setActiveRunId(runId);
            resetRunView(runViewSetters);
            loadRunData(runId);
          }
          break;
        }
        case "workflow.run_status_changed":
        case "workflow.run_cancelled": {
          if (activeRunId) loadRunData(activeRunId);
          break;
        }
        case "workflow.draft_updated":
        case "workflow.version_published":
        case "workflow.dry_run_completed": {
          break;
        }
      }
    },
    [activeRunId, setActiveRunId, runViewSetters, loadRunData],
  );

  return {
    handleDryRun,
    handleRun,
    handleCancelRun,
    handleApprove,
    handleBackToEdit,
    handleBackToList,
    handleRerunFrom,
    handleViewNodeOutput,
    handleRefreshDraft,
    running,
    isRunMode,
    isRunDone,
    dagStatus,
    runRightTab,
    setRunRightTab,
    updateNodesFromSnapshot,
    loadRunData,
    clearDryRunResult,
    handleWorkflowEvent,
    pollRef,
  };
}
