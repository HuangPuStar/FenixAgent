import { type Edge, type Node } from "@xyflow/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  type DAGEvent,
  type DAGSnapshot,
  type NodeOutput,
  type PendingApproval,
  workflowEngineApi,
} from "../../../api/workflow-engine";
import { workflowDefApi } from "../../../api/workflow-defs";
import { buildRunSummary, clearWorkflowEvents, pushWorkflowError, pushWorkflowRunStatus } from "../../../lib/use-workflow-events";
import { START_NODE_ID } from "../yaml-utils";
import { dedupEvents } from "../utils";

export interface UseWorkflowRunParams {
  workflowId: string | undefined;
  nodes: Node[];
  edges: Edge[];
  setNodes: ReturnType<typeof import("@xyflow/react").useNodesState<Node>>[1];
  setEdges: ReturnType<typeof import("@xyflow/react").useEdgesState<Edge>>[1];
  activeRunId: string | null;
  setActiveRunId: (id: string | null) => void;
  runSnapshot: DAGSnapshot | null;
  setRunSnapshot: (snap: DAGSnapshot | null) => void;
  setRunEvents: (events: DAGEvent[]) => void;
  setRunApprovals: (approvals: PendingApproval[]) => void;
  selectedRunNodeId: string | null;
  setSelectedRunNodeId: (id: string | null) => void;
  selectedNodeOutput: NodeOutput | null;
  setSelectedNodeOutput: (output: NodeOutput | null) => void;
  nodeOutputLoading: boolean;
  setNodeOutputLoading: (loading: boolean) => void;
  syncYaml: () => string;
  fitView: (opts?: { padding?: number; duration?: number }) => void;
  rightTab: string;
  setRightTab: (tab: "config" | "run" | "versions") => void;
  setMeta: (fn: (prev: import("../yaml-utils").WfMeta) => import("../yaml-utils").WfMeta) => void;
  lastSavedYaml: string;
  setLastSavedYaml: (yaml: string) => void;
}

export interface UseWorkflowRunReturn {
  handleDryRun: () => Promise<void>;
  handleRun: () => Promise<void>;
  handleCancelRun: () => Promise<void>;
  handleApprove: (approval: PendingApproval) => Promise<void>;
  handleBackToEdit: () => void;
  handleRerunFrom: (nodeId: string) => Promise<void>;
  handleViewNodeOutput: (nodeId: string) => void;
  handleRefreshDraft: () => Promise<void>;
  dryRunResult: { valid: boolean; issues: Array<{ type: string; message: string; field?: string }> } | null;
  running: boolean;
  isRunMode: boolean;
  isRunDone: boolean;
  dagStatus: string | undefined;
  runRightTab: "events" | "output";
  setRunRightTab: (tab: "events" | "output") => void;
  updateNodesFromSnapshot: (snap: DAGSnapshot) => void;
  loadRunData: (runId: string) => Promise<void>;
  clearDryRunResult: () => void;
  pollRef: React.MutableRefObject<ReturnType<typeof setInterval> | null>;
}

export function useWorkflowRun(params: UseWorkflowRunParams): UseWorkflowRunReturn {
  const {
    workflowId,
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
    selectedNodeOutput,
    setSelectedNodeOutput,
    nodeOutputLoading,
    setNodeOutputLoading,
    syncYaml,
    fitView,
    setRightTab,
    setMeta,
    lastSavedYaml,
    setLastSavedYaml,
  } = params;

  const { t } = useTranslation("workflows");

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const nodeCallbacksRef = useRef<{
    onViewOutput: (nodeId: string) => void;
    onRerunFrom: (fromNodeId: string) => void;
  }>({ onViewOutput: () => {}, onRerunFrom: () => {} });

  const [dryRunResult, setDryRunResult] = useState<{
    valid: boolean;
    issues: Array<{ type: string; message: string; field?: string }>;
  } | null>(null);
  const [running, setRunning] = useState(false);
  const [runRightTab, setRunRightTab] = useState<"events" | "output">("events");

  const isRunMode = activeRunId !== null;
  const dagStatus = runSnapshot?.dag_status;
  const isRunDone = dagStatus ? ["SUCCESS", "FAILED", "CANCELLED", "ERROR"].includes(dagStatus) : false;

  const handleDryRun = useCallback(async () => {
    const y = syncYaml();
    setRunning(true);
    setDryRunResult(null);
    try {
      const result = await workflowEngineApi.dryRun(y);
      setDryRunResult(result);
    } catch (err) {
      console.error(err);
      pushWorkflowError("validation", (err as Error).message);
      setDryRunResult({ valid: false, issues: [{ type: "error", message: (err as Error).message }] });
    } finally {
      setRunning(false);
    }
  }, [syncYaml]);

  const updateNodesFromSnapshot = useCallback(
    (snap: DAGSnapshot) => {
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id === START_NODE_ID) return n;
          const state = snap.node_states[n.id];
          if (!state)
            return {
              ...n,
              data: {
                ...n.data,
                _runStatus: undefined,
                _exitCode: undefined,
                _onViewOutput: undefined,
                _onRerunFrom: undefined,
              },
            };
          return {
            ...n,
            data: {
              ...n.data,
              _runStatus: state.status,
              _exitCode: state.exit_code,
              _onViewOutput: nodeCallbacksRef.current.onViewOutput,
              _onRerunFrom: nodeCallbacksRef.current.onRerunFrom,
            },
          };
        }),
      );
    },
    [setNodes],
  );

  const updateNodesFromSnapshotRef = useRef(updateNodesFromSnapshot);
  updateNodesFromSnapshotRef.current = updateNodesFromSnapshot;

  const loadRunData = useCallback(
    async (runId: string) => {
      try {
        const [snap, evts] = await Promise.all([
          workflowEngineApi.getRunStatus(runId),
          workflowEngineApi.getEvents(runId),
        ]);
        if (snap) {
          setRunSnapshot(snap);
          updateNodesFromSnapshotRef.current(snap);
          pushWorkflowRunStatus(buildRunSummary(snap));
        }
        if (Array.isArray(evts)) setRunEvents(dedupEvents(evts));
      } catch (err) {
        console.error(err);
      }
    },
    [setRunSnapshot, setRunEvents],
  );

  useEffect(() => {
    if (!activeRunId || !runSnapshot) return;
    const status = runSnapshot.dag_status;
    if (["SUCCESS", "FAILED", "CANCELLED", "ERROR"].includes(status)) return;
    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      await loadRunData(activeRunId);
      if (!cancelled) pollRef.current = setTimeout(poll, 2000);
    };
    pollRef.current = setTimeout(poll, 2000);
    return () => {
      cancelled = true;
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [activeRunId, runSnapshot, loadRunData]);

  useEffect(() => {
    if (!activeRunId || !runSnapshot || runSnapshot.dag_status !== "SUSPENDED") {
      setRunApprovals([]);
      return;
    }
    workflowEngineApi
      .getPendingApprovals(activeRunId)
      .then((list) => setRunApprovals(Array.isArray(list) ? list : []))
      .catch((err) => console.error(err));
  }, [activeRunId, runSnapshot, setRunApprovals]);

  useEffect(() => {
    if (!activeRunId || !selectedRunNodeId) return;
    setNodeOutputLoading(true);
    setSelectedNodeOutput(null);
    setRunRightTab("output");
    workflowEngineApi
      .getOutput(activeRunId, selectedRunNodeId)
      .then((out) => setSelectedNodeOutput(out ?? null))
      .catch((err) => console.error(err))
      .finally(() => setNodeOutputLoading(false));
  }, [activeRunId, selectedRunNodeId, setSelectedNodeOutput, setNodeOutputLoading]);

  const handleRun = useCallback(async () => {
    const y = syncYaml();
    setRunning(true);
    setDryRunResult(null);
    clearWorkflowEvents();

    if (workflowId) {
      try {
        await workflowDefApi.save(workflowId, y);
      } catch (err) {
        console.error(`${t("editor.auto_save_failed")}:`, err);
      }
    }

    setNodes((nds) =>
      nds.map((n) =>
        n.id === START_NODE_ID ? n : { ...n, data: { ...n.data, _runStatus: "RUNNING", _exitCode: undefined } },
      ),
    );

    try {
      const result = await workflowEngineApi.run(y, undefined, workflowId);
      setActiveRunId(result.runId);
      setRunSnapshot(null);
      setRunEvents([]);
      setRunApprovals([]);
      setSelectedRunNodeId(null);
      setSelectedNodeOutput(null);
      setRightTab("run");
      await loadRunData(result.runId);
    } catch (err) {
      console.error(err);
      pushWorkflowError("run", (err as Error).message);
      toast.error(`${t("editor.run_failed")}: ${(err as Error).message}`);
    } finally {
      setRunning(false);
    }
  }, [
    syncYaml,
    workflowId,
    setNodes,
    setActiveRunId,
    setRunSnapshot,
    setRunEvents,
    setRunApprovals,
    setSelectedRunNodeId,
    setSelectedNodeOutput,
    setRightTab,
    loadRunData,
    t,
  ]);

  const handleCancelRun = useCallback(async () => {
    if (!activeRunId) return;
    try {
      await workflowEngineApi.cancel(activeRunId);
      await loadRunData(activeRunId);
    } catch (err) {
      console.error(err);
      toast.error((err as Error).message);
    }
  }, [activeRunId, loadRunData]);

  const handleApprove = useCallback(
    async (approval: PendingApproval) => {
      if (!activeRunId) return;
      try {
        await workflowEngineApi.approve(activeRunId, approval.nodeId, approval.approvalToken);
        await loadRunData(activeRunId);
        const list = await workflowEngineApi.getPendingApprovals(activeRunId);
        setRunApprovals(Array.isArray(list) ? list : []);
      } catch (err) {
        console.error(err);
        toast.error((err as Error).message);
      }
    },
    [activeRunId, loadRunData, setRunApprovals],
  );

  const handleBackToEdit = useCallback(() => {
    if (pollRef.current) clearTimeout(pollRef.current);
    setActiveRunId(null);
    setRunSnapshot(null);
    setRunEvents([]);
    setRunApprovals([]);
    setSelectedRunNodeId(null);
    setSelectedNodeOutput(null);
    setRightTab("config");
    setNodes((nds) => nds.map((n) => ({ ...n, data: { ...n.data, _runStatus: undefined, _exitCode: undefined } })));
  }, [
    setActiveRunId,
    setRunSnapshot,
    setRunEvents,
    setRunApprovals,
    setSelectedRunNodeId,
    setSelectedNodeOutput,
    setRightTab,
    setNodes,
  ]);

  const handleRerunFrom = useCallback(
    async (fromNodeId: string) => {
      if (!activeRunId) return;
      const y = syncYaml();
      setRunning(true);
      setNodes((nds) => {
        const downstream = new Set<string>();
        const adjMap = new Map<string, string[]>();
        for (const e of edges) {
          if (e.source === START_NODE_ID) continue;
          const list = adjMap.get(e.source) ?? [];
          list.push(e.target);
          adjMap.set(e.source, list);
        }
        const q = [fromNodeId];
        while (q.length > 0) {
          const cur = q.shift()!;
          for (const next of adjMap.get(cur) ?? []) {
            if (!downstream.has(next)) {
              downstream.add(next);
              q.push(next);
            }
          }
        }
        return nds.map((n) => {
          if (n.id === START_NODE_ID) return n;
          const isTarget = n.id === fromNodeId || downstream.has(n.id);
          if (isTarget) return { ...n, data: { ...n.data, _runStatus: "RUNNING", _exitCode: undefined } };
          return n;
        });
      });

      try {
        const result = await workflowEngineApi.rerunFrom(activeRunId, y, fromNodeId, workflowId);
        setActiveRunId(result.runId);
        setRunSnapshot(null);
        setRunEvents([]);
        setRunApprovals([]);
        setSelectedRunNodeId(null);
        setSelectedNodeOutput(null);
        setRightTab("run");
        await loadRunData(result.runId);
      } catch (err) {
        console.error(err);
        toast.error(`${t("editor.rerun_failed")}: ${(err as Error).message}`);
      } finally {
        setRunning(false);
      }
    },
    [
      activeRunId,
      syncYaml,
      workflowId,
      edges,
      setNodes,
      setActiveRunId,
      setRunSnapshot,
      setRunEvents,
      setRunApprovals,
      setSelectedRunNodeId,
      setSelectedNodeOutput,
      setRightTab,
      loadRunData,
      t,
    ],
  );

  const handleViewNodeOutput = useCallback(
    async (nodeId: string) => {
      if (!activeRunId) return;
      setSelectedRunNodeId(nodeId);
      setRunRightTab("output");
      setNodeOutputLoading(true);
      setSelectedNodeOutput(null);
      setRightTab("run");
      try {
        const out = await workflowEngineApi.getOutput(activeRunId, nodeId);
        setSelectedNodeOutput(out ?? null);
      } catch (err) {
        console.error(err);
        setSelectedNodeOutput(null);
      } finally {
        setNodeOutputLoading(false);
      }
    },
    [activeRunId, setSelectedRunNodeId, setNodeOutputLoading, setSelectedNodeOutput, setRightTab],
  );

  nodeCallbacksRef.current.onViewOutput = handleViewNodeOutput;
  nodeCallbacksRef.current.onRerunFrom = handleRerunFrom;

  // handleRefreshDraft — 刷新草稿（需要 persistence 的 lastSavedYaml/setLastSavedYaml）
  const handleRefreshDraft = useCallback(async () => {
    if (!workflowId) return;
    if (isRunMode && !isRunDone) return;
    const { yamlToFlow } = await import("../yaml-utils");
    try {
      const wf = await workflowDefApi.get(workflowId);
      if (wf.draftYaml) {
        const { nodes: newNodes, edges: newEdges, meta: newMeta } = yamlToFlow(wf.draftYaml);
        setNodes(newNodes);
        setEdges(newEdges);
        setMeta(() => newMeta);
        setLastSavedYaml(wf.draftYaml);
        if (activeRunId) {
          try {
            const snap = await workflowEngineApi.getRunStatus(activeRunId);
            if (snap) updateNodesFromSnapshotRef.current(snap);
          } catch (err) {
            console.error(`${t("editor.restore_run_failed")}:`, err);
          }
        }
        setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 50);
      }
    } catch (err) {
      console.error(`${t("editor.refresh_failed")}:`, err);
    }
  }, [
    workflowId,
    isRunMode,
    isRunDone,
    activeRunId,
    setNodes,
    setEdges,
    setMeta,
    setLastSavedYaml,
    fitView,
    updateNodesFromSnapshotRef,
    t,
  ]);

  const clearDryRunResult = useCallback(() => setDryRunResult(null), []);

  return {
    handleDryRun,
    handleRun,
    handleCancelRun,
    handleApprove,
    handleBackToEdit,
    handleRerunFrom,
    handleViewNodeOutput,
    handleRefreshDraft,
    dryRunResult,
    running,
    isRunMode,
    isRunDone,
    dagStatus,
    runRightTab,
    setRunRightTab,
    updateNodesFromSnapshot,
    loadRunData,
    clearDryRunResult,
    pollRef,
  };
}
