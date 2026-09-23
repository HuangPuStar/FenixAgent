import { unwrap } from "@fenix/web-runtime/api/request";
import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  type DAGEvent,
  type DAGSnapshot,
  type NodeOutput,
  type PendingApproval,
  workflowEngineApi,
} from "../../../api/workflow-engine";
import { buildRunSummary, pushWorkflowRunStatus } from "../../../lib/use-workflow-events";
import { isTerminalDagStatus } from "../run-canvas-model";
import { dedupEvents } from "../utils";

/**
 * 运行数据的**取数与回写**（传输适配层，§3.5）。
 *
 * 三处读取此前内联在 `useWorkflowRun` 里，与命令面（运行 / 取消 / 审批 / 重跑）混在一个文件中：
 * ① 每 2s 轮询的运行快照 + 事件流；② SUSPENDED 时的待审批列表；③ 选中节点后的节点输出。
 * 三者都只做「读服务端 → 写运行视图态」，不决定去哪个运行、也不推进编辑器的状态机，所以按职责切开。
 *
 * **为什么不改用 `useRequest`**（§3.4 口径，也是 §3.6 里留给本轮的问题）：
 * 这三个 setter 写的 `runSnapshot` / `runEvents` / `runApprovals` / `selectedNodeOutput` 是**跨组件共享的
 * 运行视图态**——`WorkflowEditor` 顶层持有，`RunStatusPanel` 也直接写它们（运行记录里点一条、清空选中），
 * 三处共用 `resetRunView` 整组复位。把取数交给 `useRequest` 会让 hook 内部再持一份同一状态的数据
 * （`data`），同一份状态出现两个所有者；拆分只搬动取数代码的位置，不改变状态归属，所以这里仍按
 * 「调用方持有的 setter 入参 + 显式 cleanup」的形态实现。轮询另有两条 `useRequest` 表达不了的语义：
 * 退出运行视图 / 重跑时要**同步**停掉定时器（不能让上一个 run 的结果回写），以及 §3.4 明确要求的
 * 「不要依赖 `useRequest` 替你取消」。
 */
export interface UseWorkflowRunTransportParams {
  workflowId: string | undefined;
  activeRunId: string | null;
  runSnapshot: DAGSnapshot | null;
  selectedRunNodeId: string | null;
  setRunSnapshot: (snap: DAGSnapshot | null) => void;
  setRunEvents: (events: DAGEvent[]) => void;
  setRunApprovals: (approvals: PendingApproval[]) => void;
  setSelectedNodeOutput: (output: NodeOutput | null) => void;
  setNodeOutputLoading: (loading: boolean) => void;
  setRunRightTab: (tab: "events" | "output") => void;
  /** 快照到终态时把「运行中」按钮态落下（`running` 由命令面持有） */
  setRunning: (running: boolean) => void;
  /** 快照落画布。节点回调随渲染变化，用 ref 取最新（与拆分前一致） */
  applySnapshotRef: React.MutableRefObject<(snap: DAGSnapshot) => void>;
}

export interface UseWorkflowRunTransportReturn {
  loadRunData: (runId: string) => Promise<void>;
  /** 轮询定时器：退出运行视图 / 重跑时要能立刻停掉 */
  pollRef: React.MutableRefObject<ReturnType<typeof setInterval> | null>;
}

export function useWorkflowRunTransport({
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
  applySnapshotRef,
}: UseWorkflowRunTransportParams): UseWorkflowRunTransportReturn {
  const { t } = useTranslation("workflows");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadRunData = useCallback(
    async (runId: string) => {
      try {
        const [snap, evts] = await Promise.all([
          unwrap(workflowEngineApi.getRunStatus(runId)),
          unwrap(workflowEngineApi.getEvents(runId)),
        ]);
        if (snap) {
          setRunSnapshot(snap);
          applySnapshotRef.current(snap);
          pushWorkflowRunStatus(workflowId, buildRunSummary(snap));
        }
        if (Array.isArray(evts)) setRunEvents(dedupEvents(evts));
      } catch (err) {
        console.error(err);
      }
    },
    [setRunSnapshot, setRunEvents, workflowId, applySnapshotRef],
  );

  useEffect(() => {
    if (!activeRunId) return;
    if (runSnapshot && isTerminalDagStatus(runSnapshot.dag_status)) {
      setRunning(false);
      return;
    }
    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      await loadRunData(activeRunId);
      if (!cancelled) pollRef.current = setTimeout(poll, 2_000);
    };
    // 引擎异步执行，轮询 2s 获取实时快照
    pollRef.current = setTimeout(poll, 2_000);
    return () => {
      cancelled = true;
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [activeRunId, runSnapshot, loadRunData, setRunning]);

  useEffect(() => {
    if (!activeRunId || !runSnapshot || runSnapshot.dag_status !== "SUSPENDED") {
      setRunApprovals([]);
      return;
    }
    unwrap(workflowEngineApi.getPendingApprovals(activeRunId))
      .then((list) => setRunApprovals(Array.isArray(list) ? list : []))
      .catch((err) => console.error(err));
  }, [activeRunId, runSnapshot, setRunApprovals]);

  useEffect(() => {
    if (!activeRunId || !selectedRunNodeId) return;
    setNodeOutputLoading(true);
    setSelectedNodeOutput(null);
    setRunRightTab("output");
    unwrap(workflowEngineApi.getOutput(activeRunId, selectedRunNodeId))
      .then((out) => setSelectedNodeOutput(out ?? null))
      .catch((err) => {
        console.error(err);
        // 选中节点后的拉取失败会让输出面板停在空态。这是画布点节点 / 点事件行两条入口的公共路径，
        // 提示放在这里（而不是 handleViewNodeOutput）才能覆盖全两条且一次操作只报一条
        toast.error(t("editor.output_load_failed"));
      })
      .finally(() => setNodeOutputLoading(false));
  }, [activeRunId, selectedRunNodeId, setSelectedNodeOutput, setNodeOutputLoading, setRunRightTab, t]);

  return { loadRunData, pollRef };
}
