import { unwrap } from "@fenix/web-runtime/api/request";
import type { Edge, Node } from "@xyflow/react";
import { useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { workflowDefApi } from "../../../api/workflow-defs";
import { type PendingApproval, workflowEngineApi } from "../../../api/workflow-engine";
import { clearWorkflowEvents, pushWorkflowError } from "../../../lib/use-workflow-events";
import { markAllNodesRunning, markDownstreamRunning } from "../run-canvas-model";
import { type RunViewSetters, resetRunView } from "../run-view";

/**
 * 运行的生命周期命令：发起运行、取消、审批、从某节点重跑。
 *
 * 四者的共同形态是「改当前这一次运行的状态」——都要拿提交锁、都要在成功后「换 runId + 复位运行视图 +
 * 打开运行抽屉 + 装入新运行的快照与事件」，都要把失败按字典文案上屏（§9.3）。退出运行视图、节点输出、
 * SSE 事件分发、dry-run 与草稿刷新留在 `useWorkflowRun.ts`：那几件事不新起运行，只与运行视图态和编辑器
 * 打交道。
 *
 * 入参是「命令需要的运行态 + 视图入口」的显式清单（与 `useWorkflowRun` 本身的入参形态一致）。
 * `isSubmittingRef`（同一时刻只允许一次提交）只服务本文件，因此在这里创建；`pollRef` 由传输层持有，
 * 重跑时要先停掉旧 run 的轮询，故作为入参传入。
 */
export interface UseWorkflowRunLifecycleParams {
  workflowId: string | undefined;
  edges: Edge[];
  activeRunId: string | null;
  setActiveRunId: (id: string | null) => void;
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
  setRunning: (running: boolean) => void;
  setDryRunResult: (
    result: { valid: boolean; issues: Array<{ type: string; message: string; field?: string }> } | null,
  ) => void;
  setRunApprovals: (approvals: PendingApproval[]) => void;
  syncYaml: () => string;
  resolveDefaultParams: () => Record<string, unknown> | undefined;
  /** 轮询定时器：重跑前必须停掉旧 run 的轮询，不让它的结果回写 */
  pollRef: React.MutableRefObject<ReturnType<typeof setInterval> | null>;
  runViewSetters: RunViewSetters;
  openRunSheet: () => void;
  loadRunData: (runId: string) => Promise<void>;
}

export interface UseWorkflowRunLifecycleReturn {
  handleRun: (params?: Record<string, unknown>) => Promise<void>;
  handleCancelRun: () => Promise<void>;
  handleApprove: (approval: PendingApproval) => Promise<void>;
  handleRerunFrom: (nodeId: string) => Promise<void>;
}

export function useWorkflowRunLifecycle({
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
}: UseWorkflowRunLifecycleParams): UseWorkflowRunLifecycleReturn {
  const { t } = useTranslation("workflows");
  /** 提交锁：运行 / 重跑在途时忽略重复触发。只服务本文件，故不由调用方持有。 */
  const isSubmittingRef = useRef(false);

  const handleRun = useCallback(
    async (params?: Record<string, unknown>) => {
      if (isSubmittingRef.current) return;
      isSubmittingRef.current = true;
      const y = syncYaml();
      setRunning(true);
      setDryRunResult(null);
      clearWorkflowEvents(workflowId);

      if (workflowId) {
        try {
          await unwrap(workflowDefApi.save(workflowId, y));
        } catch (err) {
          console.error(`${t("editor.auto_save_failed")}:`, err);
          // 运行前自动保存失败：只上屏字典文案（§9.3），后端信封原文留在上面的日志里。
          toast.error(t("editor.auto_save_failed"));
          setRunning(false);
          isSubmittingRef.current = false;
          return;
        }
      }

      setNodes((nds) => markAllNodesRunning(nds));

      try {
        const runParams = params ?? resolveDefaultParams();
        const result = await unwrap(workflowEngineApi.run(y, runParams, workflowId));
        setActiveRunId(result.runId);
        resetRunView(runViewSetters);
        openRunSheet();
        await loadRunData(result.runId);
        // running 保持 true，轮询检测到终止状态时重置
      } catch (err) {
        console.error(err);
        pushWorkflowError(workflowId, "run", (err as Error).message);
        toast.error(t("editor.run_failed"));
        setRunning(false);
      } finally {
        isSubmittingRef.current = false;
      }
    },
    [
      syncYaml,
      workflowId,
      setNodes,
      setActiveRunId,
      runViewSetters,
      openRunSheet,
      loadRunData,
      resolveDefaultParams,
      setRunning,
      setDryRunResult,
      t,
    ],
  );

  const handleCancelRun = useCallback(async () => {
    if (!activeRunId) return;
    try {
      await unwrap(workflowEngineApi.cancel(activeRunId));
      await loadRunData(activeRunId);
    } catch (err) {
      console.error(err);
      // 原来是裸回显 `(err as Error).message`（连标题都没有）；§9.3 要求按稳定文案上屏。
      toast.error(t("editor.cancel_run_failed"));
    }
  }, [activeRunId, loadRunData, t]);

  const handleApprove = useCallback(
    async (approval: PendingApproval) => {
      if (!activeRunId) return;
      try {
        await unwrap(workflowEngineApi.approve(activeRunId, approval.nodeId, approval.approvalToken));
        await loadRunData(activeRunId);
        const list = await unwrap(workflowEngineApi.getPendingApprovals(activeRunId));
        setRunApprovals(Array.isArray(list) ? list : []);
      } catch (err) {
        console.error(err);
        toast.error(t("editor.approve_failed"));
      }
    },
    [activeRunId, loadRunData, setRunApprovals, t],
  );

  const handleRerunFrom = useCallback(
    async (fromNodeId: string) => {
      if (!activeRunId || isSubmittingRef.current) return;
      isSubmittingRef.current = true;
      if (pollRef.current) {
        clearTimeout(pollRef.current);
        pollRef.current = null;
      }
      const y = syncYaml();
      if (workflowId) {
        try {
          await unwrap(workflowDefApi.save(workflowId, y));
        } catch (err) {
          console.error(`${t("editor.auto_save_failed")}:`, err);
          toast.error(t("editor.auto_save_failed"));
          isSubmittingRef.current = false;
          return;
        }
      }
      setRunning(true);
      setNodes((nds) => markDownstreamRunning(nds, edges, fromNodeId));

      try {
        const result = await unwrap(workflowEngineApi.rerunFrom(activeRunId, y, fromNodeId, workflowId));
        setActiveRunId(result.runId);
        resetRunView(runViewSetters);
        openRunSheet();
        await loadRunData(result.runId);
      } catch (err) {
        console.error(err);
        toast.error(t("editor.rerun_failed"));
      } finally {
        setRunning(false);
        isSubmittingRef.current = false;
      }
    },
    [
      activeRunId,
      syncYaml,
      workflowId,
      edges,
      setNodes,
      setActiveRunId,
      runViewSetters,
      openRunSheet,
      loadRunData,
      setRunning,
      t,
      pollRef,
    ],
  );

  return { handleRun, handleCancelRun, handleApprove, handleRerunFrom };
}
