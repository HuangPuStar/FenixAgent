import { ArrowLeft, Edit3, Loader, RefreshCw, ShieldCheck, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
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
              workflowEngineApi.getRunStatus(runId),
              workflowEngineApi.getEvents(runId),
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
        onClose={handleBackToList}
      />
    );
  }

  return (
    <>
      {/* 运行状态头 */}
      <div
        style={{
          padding: "10px 12px",
          borderBottom: "1px solid #e5e7eb",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <button
          type="button"
          onClick={handleBackToList}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 26,
            height: 26,
            border: "none",
            background: "#f3f4f6",
            borderRadius: 4,
            color: "#374151",
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          <ArrowLeft size={14} />
        </button>
        <span style={{ fontSize: 14, fontWeight: 600, color: "#111827" }}>{t("editor.run_result")}</span>
        {runSnapshot && (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 3,
              padding: "2px 8px",
              borderRadius: 99,
              fontSize: 12,
              fontWeight: 500,
              color: DAG_STATUS_CFG[dagStatus!]?.color ?? "#6b7280",
              background: DAG_STATUS_CFG[dagStatus!]?.bg ?? "#f3f4f6",
            }}
          >
            {dagStatus === "RUNNING" && (
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "#3b82f6",
                  animation: "wf-pulse 1.5s ease-in-out infinite",
                }}
              />
            )}
            {DAG_STATUS_CFG[dagStatus!] ? t(DAG_STATUS_CFG[dagStatus!].labelKey) : dagStatus}
          </span>
        )}
        <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
          {!isRunDone && (
            <button
              type="button"
              onClick={handleCancelRun}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 28,
                height: 28,
                border: "none",
                background: "#fef2f2",
                borderRadius: 4,
                color: "#ef4444",
                cursor: "pointer",
              }}
            >
              <Square size={13} />
            </button>
          )}
          {isRunDone && (
            <button
              type="button"
              onClick={handleBackToEdit}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 28,
                height: 28,
                border: "none",
                background: "#f3f4f6",
                borderRadius: 4,
                color: "#6b7280",
                cursor: "pointer",
              }}
            >
              <Edit3 size={13} />
            </button>
          )}
        </div>
      </div>

      {/* 审批卡片 */}
      {dagStatus === "SUSPENDED" && runApprovals.length > 0 && (
        <div style={{ padding: 12, borderBottom: "1px solid #fbbf24", background: "#fffbeb" }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "#92400e",
              marginBottom: 8,
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <ShieldCheck size={14} /> {t("editor.waiting_approval")}
          </div>
          {runApprovals.map((a) => (
            <div key={a.nodeId} style={{ fontSize: 12, color: "#78350f", marginBottom: 8 }}>
              <div style={{ fontWeight: 500, marginBottom: 2 }}>{t("editor.approval_node", { nodeId: a.nodeId })}</div>
              {a.displayData != null && typeof a.displayData === "object" && (
                <div style={{ color: "#92400e", marginBottom: 4 }}>
                  {String(((a.displayData as Record<string, unknown>).message as string) ?? "")}
                </div>
              )}
              <button
                type="button"
                onClick={() => handleApprove(a)}
                style={{
                  padding: "3px 10px",
                  border: "1px solid #f59e0b",
                  borderRadius: 4,
                  background: "#f59e0b",
                  color: "#fff",
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                {t("editor.approve")}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 进度条 */}
      {runSnapshot && (
        <div
          style={{
            padding: "6px 12px",
            borderBottom: "1px solid #f3f4f6",
            fontSize: 12,
            color: "#4b5563",
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <span>
            {t("editor.progress_nodes", {
              completed: Object.values(runSnapshot.node_states).filter((s) => s.status === "COMPLETED").length,
              total: Object.keys(runSnapshot.node_states).length,
            })}
          </span>
          <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 11 }}>{activeRunId?.substring(0, 16)}...</span>
        </div>
      )}

      {/* 事件/输出子 Tab */}
      <div style={{ display: "flex", borderBottom: "1px solid #e5e7eb" }}>
        <button
          type="button"
          onClick={() => setRunRightTab("events")}
          style={{
            flex: 1,
            padding: "8px 0",
            border: "none",
            background: "none",
            fontSize: 13,
            fontWeight: runRightTab === "events" ? 600 : 400,
            color: runRightTab === "events" ? "#111827" : "#4b5563",
            borderBottom: runRightTab === "events" ? "2px solid #3b82f6" : "2px solid transparent",
            cursor: "pointer",
          }}
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
          style={{
            flex: 1,
            padding: "8px 0",
            border: "none",
            background: "none",
            fontSize: 13,
            fontWeight: runRightTab === "output" ? 600 : 400,
            color: runRightTab === "output" ? "#111827" : "#4b5563",
            borderBottom: runRightTab === "output" ? "2px solid #3b82f6" : "2px solid transparent",
            cursor: "pointer",
          }}
        >
          {selectedRunNodeId ? t("editor.output_tab_selected", { nodeId: selectedRunNodeId }) : t("editor.output_tab")}
        </button>
      </div>

      {/* 事件列表 */}
      {runRightTab === "events" && (
        <div style={{ flex: 1, overflowY: "auto", fontSize: 13 }}>
          {(() => {
            const filtered = selectedRunNodeId ? runEvents.filter((e) => e.node_id === selectedRunNodeId) : runEvents;
            return filtered.length === 0 ? (
              <div style={{ padding: 20, textAlign: "center", color: "#6b7280" }}>
                {selectedRunNodeId ? t("editor.no_events_for_node") : t("editor.no_events")}
              </div>
            ) : (
              filtered.map((evt) => (
                <div
                  key={evt.event_id}
                  style={{
                    padding: "6px 12px",
                    borderBottom: "1px solid #f3f4f6",
                    display: "flex",
                    gap: 6,
                    alignItems: "flex-start",
                    cursor: evt.node_id ? "pointer" : "default",
                  }}
                  onClick={() => {
                    if (evt.node_id) setSelectedRunNodeId(evt.node_id);
                  }}
                >
                  <EventIcon type={evt.type} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                      <span style={{ fontWeight: 500, color: "#374151" }}>{formatEventType(t, evt.type)}</span>
                      <span style={{ color: "#6b7280", fontSize: 11, flexShrink: 0 }}>
                        {new Date(evt.timestamp).toLocaleTimeString("zh-CN", {
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                        })}
                      </span>
                    </div>
                    {evt.node_id && (
                      <span style={{ color: "#4b5563", fontFamily: "ui-monospace, monospace", fontSize: 11 }}>
                        {evt.node_id}
                      </span>
                    )}
                    {evt.metadata && Object.keys(evt.metadata).length > 0 && (
                      <div
                        style={{
                          color: "#4b5563",
                          fontSize: 11,
                          marginTop: 2,
                          fontFamily: "ui-monospace, monospace",
                        }}
                      >
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
        <div style={{ flex: 1, overflowY: "auto", fontSize: 13 }}>
          {!selectedRunNodeId ? (
            <div style={{ padding: 20, textAlign: "center", color: "#6b7280" }}>{t("editor.click_node_output")}</div>
          ) : nodeOutputLoading ? (
            <div style={{ padding: 20, textAlign: "center", color: "#4b5563" }}>
              <Loader size={16} style={{ animation: "wf-spin 1s linear infinite", display: "inline-block" }} />
            </div>
          ) : !selectedNodeOutput ? (
            <div style={{ padding: 20, textAlign: "center", color: "#6b7280" }}>{t("editor.no_output")}</div>
          ) : (
            <>
              <div
                style={{
                  padding: "8px 12px",
                  borderBottom: "1px solid #f3f4f6",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 6,
                }}
              >
                <span style={{ fontSize: 12, color: "#6b7280", fontFamily: "ui-monospace, monospace" }}>
                  {selectedRunNodeId}
                </span>
                <button
                  type="button"
                  onClick={() => handleRerunFrom(selectedRunNodeId)}
                  disabled={running}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 3,
                    padding: "3px 10px",
                    border: "1px solid #3b82f6",
                    borderRadius: 4,
                    background: "#eff6ff",
                    color: "#3b82f6",
                    fontSize: 12,
                    fontWeight: 500,
                    cursor: running ? "not-allowed" : "pointer",
                    opacity: running ? 0.5 : 1,
                  }}
                >
                  <RefreshCw size={12} /> {t("editor.rerun_from_here")}
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
