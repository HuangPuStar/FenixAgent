import { ArrowLeft, Edit3, Loader, RefreshCw, ShieldCheck, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import { unwrap } from "@/src/api/request";
import {
  type DAGEvent,
  type DAGSnapshot,
  type NodeOutput,
  type PendingApproval,
  workflowEngineApi,
} from "../../../api/workflow-engine";
import { DAG_STATUS_CFG, dedupEvents, formatEventType, formatMeta } from "../utils";
import { EventIcon } from "./EventIcon";
import { NodeOutputView } from "./NodeOutputView";
import { RunListPanel } from "./RunListPanel";

export interface RunStatusPanelProps {
  activeRunId: string | null;
  runSnapshot: DAGSnapshot | null;
  dagStatus: string | undefined;
  isRunMode: boolean;
  isRunDone: boolean;
  running: boolean;
  runEvents: DAGEvent[];
  runApprovals: PendingApproval[];
  runRightTab: "events" | "output";
  setRunRightTab: (tab: "events" | "output") => void;
  selectedRunNodeId: string | null;
  setSelectedRunNodeId: (id: string | null) => void;
  selectedNodeOutput: NodeOutput | null;
  nodeOutputLoading: boolean;
  handleCancelRun: () => Promise<void>;
  handleBackToEdit: () => void;
  handleBackToList: () => void;
  handleApprove: (approval: PendingApproval) => Promise<void>;
  handleRerunFrom: (fromNodeId: string) => Promise<void>;
  setActiveRunId: (id: string | null) => void;
  setRunSnapshot: (snap: DAGSnapshot | null) => void;
  setRunEvents: (events: DAGEvent[]) => void;
  setRunApprovals: (approvals: PendingApproval[]) => void;
  setSelectedNodeOutput: (output: NodeOutput | null) => void;
  updateNodesFromSnapshot: (snap: DAGSnapshot) => void;
  setRightTab: (tab: "config" | "run" | "versions") => void;
}

export function RunStatusPanel({
  activeRunId,
  runSnapshot,
  dagStatus,
  isRunMode,
  isRunDone,
  running,
  runEvents,
  runApprovals,
  runRightTab,
  setRunRightTab,
  selectedRunNodeId,
  setSelectedRunNodeId,
  selectedNodeOutput,
  nodeOutputLoading,
  handleCancelRun,
  handleBackToEdit,
  handleBackToList,
  handleApprove,
  handleRerunFrom,
  setActiveRunId,
  setRunSnapshot,
  setRunEvents,
  setRunApprovals,
  setSelectedNodeOutput,
  updateNodesFromSnapshot,
  setRightTab,
}: RunStatusPanelProps) {
  const { t } = useTranslation("workflows");

  if (!isRunMode) {
    return (
      <RunListPanel
        onSelect={async (runId) => {
          setActiveRunId(runId);
          setRunSnapshot(null);
          setRunEvents([]);
          setRunApprovals([]);
          setSelectedRunNodeId(null);
          setSelectedNodeOutput(null);
          try {
            const [snap, evts] = await Promise.all([
              unwrap(workflowEngineApi.getRunStatus(runId)),
              unwrap(workflowEngineApi.getEvents(runId)),
            ]);
            if (snap) {
              setRunSnapshot(snap);
              updateNodesFromSnapshot(snap);
            }
            if (Array.isArray(evts)) setRunEvents(dedupEvents(evts));
          } catch (err) {
            console.error(`${t("editor.load_run_data_failed")}:`, err);
          }
        }}
        onClose={() => setRightTab("config")}
      />
    );
  }

  return (
    <>
      {/* 运行状态头 */}
      <div className="px-3 py-2 border-b border-border-subtle flex items-center gap-1.5">
        <button
          type="button"
          onClick={handleBackToList}
          className="flex items-center justify-center w-[22px] h-[22px] border-none bg-surface-2 rounded text-text-secondary cursor-pointer shrink-0 hover:bg-surface-hover transition-colors"
        >
          <ArrowLeft size={12} />
        </button>
        <span className="text-xs font-semibold text-text-primary">{t("editor.run_result")}</span>
        {runSnapshot && (
          <span
            className="inline-flex items-center gap-1 px-1.5 py-px rounded-full text-[10px] font-medium"
            style={{
              color: DAG_STATUS_CFG[dagStatus!]?.color ?? "var(--color-text-secondary)",
              background: DAG_STATUS_CFG[dagStatus!]?.bg ?? "var(--color-surface-2)",
            }}
          >
            {dagStatus === "RUNNING" && <span className="w-[5px] h-[5px] rounded-full bg-brand animate-pulse" />}
            {DAG_STATUS_CFG[dagStatus!] ? t(DAG_STATUS_CFG[dagStatus!].labelKey) : dagStatus}
          </span>
        )}
        <div className="ml-auto flex gap-1">
          {!isRunDone && (
            <button
              type="button"
              onClick={handleCancelRun}
              className="flex items-center justify-center w-6 h-6 border-none rounded text-status-error cursor-pointer hover:bg-surface-hover transition-colors bg-red-50"
            >
              <Square size={11} />
            </button>
          )}
          {isRunDone && (
            <button
              type="button"
              onClick={handleBackToEdit}
              className="flex items-center justify-center w-6 h-6 border-none bg-surface-2 rounded text-text-secondary cursor-pointer hover:bg-surface-hover transition-colors"
            >
              <Edit3 size={11} />
            </button>
          )}
        </div>
      </div>

      {/* 审批卡片 */}
      {dagStatus === "SUSPENDED" && runApprovals.length > 0 && (
        <div className="p-2.5 border-b border-warning-border bg-warning-bg">
          <div className="text-[11px] font-semibold text-warning-text mb-1.5 flex items-center gap-1">
            <ShieldCheck size={12} /> {t("editor.waiting_approval")}
          </div>
          {runApprovals.map((a) => (
            <div key={a.nodeId} className="text-[10px] text-amber-800 mb-1.5">
              <div className="font-medium mb-0.5">{t("editor.approval_node", { nodeId: a.nodeId })}</div>
              {a.displayData != null && typeof a.displayData === "object" && (
                <div className="text-warning-text mb-1">
                  {String(((a.displayData as Record<string, unknown>).message as string) ?? "")}
                </div>
              )}
              <button
                type="button"
                onClick={() => handleApprove(a)}
                className="px-2 py-0.5 border border-warning-border rounded bg-warning-border text-white text-[10px] font-medium cursor-pointer hover:opacity-90 transition-opacity"
              >
                {t("editor.approve")}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 进度条 */}
      {runSnapshot && (
        <div className="px-3 py-1 border-b border-border-subtle text-[10px] text-text-secondary flex justify-between">
          <span>
            {t("editor.progress_nodes", {
              completed: Object.values(runSnapshot.node_states ?? {}).filter((s) => s.status === "COMPLETED").length,
              total: Object.keys(runSnapshot.node_states ?? {}).length,
            })}
          </span>
          <span className="font-mono text-[9px]">{activeRunId?.substring(0, 16)}...</span>
        </div>
      )}

      {/* 事件/输出子 Tab */}
      <div className="flex border-b border-border-subtle">
        <button
          type="button"
          onClick={() => setRunRightTab("events")}
          className={`flex-1 py-[7px] border-none bg-transparent text-[11px] cursor-pointer transition-colors ${
            runRightTab === "events"
              ? "font-semibold text-text-primary border-b-2 border-brand"
              : "font-normal text-text-secondary border-b-2 border-transparent"
          }`}
        >
          {t("editor.events_tab", {
            count: selectedRunNodeId
              ? runEvents.filter((e) => e.node_id === selectedRunNodeId).length
              : runEvents.length,
          })}
        </button>
        <button
          type="button"
          onClick={() => setRunRightTab("output")}
          className={`flex-1 py-[7px] border-none bg-transparent text-[11px] cursor-pointer transition-colors ${
            runRightTab === "output"
              ? "font-semibold text-text-primary border-b-2 border-brand"
              : "font-normal text-text-secondary border-b-2 border-transparent"
          }`}
        >
          {selectedRunNodeId ? t("editor.output_tab_selected", { nodeId: selectedRunNodeId }) : t("editor.output_tab")}
        </button>
      </div>

      {/* 事件列表 */}
      {runRightTab === "events" && (
        <div className="flex-1 overflow-y-auto text-[11px]">
          {(() => {
            const filtered = selectedRunNodeId ? runEvents.filter((e) => e.node_id === selectedRunNodeId) : runEvents;
            return filtered.length === 0 ? (
              <div className="py-5 text-center text-text-secondary">
                {selectedRunNodeId ? t("editor.no_events_for_node") : t("editor.no_events")}
              </div>
            ) : (
              filtered.map((evt) => (
                <div
                  key={evt.event_id}
                  className="px-3 py-[5px] border-b border-border-subtle flex gap-1.5 items-start"
                  style={{ cursor: evt.node_id ? "pointer" : "default" }}
                  onClick={() => {
                    if (evt.node_id) setSelectedRunNodeId(evt.node_id);
                  }}
                >
                  <EventIcon type={evt.type} />
                  <div className="flex-1 min-w-0">
                    <div className="flex justify-between mb-px">
                      <span className="font-medium text-text-secondary">{formatEventType(t, evt.type)}</span>
                      <span className="text-text-muted text-[9px] shrink-0">
                        {new Date(evt.timestamp).toLocaleTimeString("zh-CN", {
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                        })}
                      </span>
                    </div>
                    {evt.node_id && <span className="text-text-secondary font-mono text-[9px]">{evt.node_id}</span>}
                    {evt.metadata && Object.keys(evt.metadata).length > 0 && (
                      <div className="text-text-secondary text-[9px] mt-px font-mono">
                        {formatMeta(t, evt.type, evt.metadata)}
                      </div>
                    )}
                  </div>
                </div>
              ))
            );
          })()}
        </div>
      )}

      {/* 节点输出 */}
      {runRightTab === "output" && (
        <div className="flex-1 overflow-y-auto text-[11px]">
          {!selectedRunNodeId ? (
            <div className="py-5 text-center text-text-secondary">{t("editor.click_node_output")}</div>
          ) : nodeOutputLoading ? (
            <div className="py-5 text-center text-text-secondary">
              <Loader size={14} className="animate-spin inline-block" />
            </div>
          ) : !selectedNodeOutput ? (
            <div className="py-5 text-center text-text-secondary">{t("editor.no_output")}</div>
          ) : (
            <>
              <div className="px-3 py-1.5 border-b border-border-subtle flex items-center justify-between gap-1.5">
                <span className="text-[10px] text-text-muted font-mono">{selectedRunNodeId}</span>
                <button
                  type="button"
                  onClick={() => handleRerunFrom(selectedRunNodeId)}
                  disabled={running}
                  className="flex items-center gap-1 px-2 py-0.5 border border-brand rounded bg-brand-subtle text-brand text-[10px] font-medium cursor-pointer disabled:opacity-50 hover:bg-surface-hover transition-colors"
                >
                  <RefreshCw size={10} /> {t("editor.rerun_from_here")}
                </button>
              </div>
              <NodeOutputView output={selectedNodeOutput} />
            </>
          )}
        </div>
      )}
    </>
  );
}
