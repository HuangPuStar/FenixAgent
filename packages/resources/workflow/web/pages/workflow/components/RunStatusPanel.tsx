import { Tabs, TabsContent, TabsList, TabsTrigger } from "@fenix/ui-components/ui/tabs";
import { unwrap } from "@fenix/web-runtime/api/request";
import { ArrowLeft, Edit3, RefreshCw, ShieldCheck, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  type DAGEvent,
  type DAGSnapshot,
  type NodeOutput,
  type PendingApproval,
  workflowEngineApi,
} from "../../../api/workflow-engine";
import { resetRunView } from "../run-view";
import { DAG_STATUS_CFG, dedupEvents, formatEventType, formatMeta } from "../utils";
import { EventIcon } from "./EventIcon";
import { InlineLoader } from "./InlineLoader";
import { NodeOutputView } from "./NodeOutputView";
import { RunListPanel } from "./RunListPanel";

/**
 * 事件/输出子 Tab 的触发项样式。
 *
 * 视觉沿用改造前手写的 tab 条——选中态是 2px 品牌色下划线 + 加粗，未选态是透明下划线，
 * 只把表达方式换成标准刻度（`text-xs` 取代 `text-[11px]`）。两处刻意分叉：
 * - `after:hidden`：组件 line 变体自带的 ::after 指示条固定在触发项底部 -5px（落到条带下边框之外），
 *   与本面板「下划线压在下边框上」的视觉不符，故关掉它、改用 border 表达同一效果；
 * - `whitespace-normal`：组件默认 nowrap，长节点 id（如 `输出 (custom_transform_1)`）会溢出触发项框，
 *   而改造前是普通可换行文本，这里显式恢复。
 *
 * 高度不写死：`h-auto` + 列表 `items-stretch` 让触发项撑满组件标准条高（h-9），下划线因此压在条带下沿。
 */
const RUN_TAB_TRIGGER =
  "h-auto rounded-none border-0 border-b-2 border-transparent bg-transparent px-2 text-xs font-normal text-text-secondary whitespace-normal transition-colors after:hidden data-[state=active]:border-brand data-[state=active]:font-semibold data-[state=active]:text-text-primary";

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
  const { t, i18n } = useTranslation("workflows");

  if (!isRunMode) {
    return (
      <RunListPanel
        onSelect={async (runId) => {
          setActiveRunId(runId);
          // 点选一条运行记录 = 进入一次运行视图：整组清空后由下面的拉取填值（见 ../run-view.ts）
          resetRunView({ setRunSnapshot, setRunEvents, setRunApprovals, setSelectedRunNodeId, setSelectedNodeOutput });
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
            // 点击运行记录后 runId 已切换，拉取失败会让右侧面板停在空态，必须有可见反馈
            toast.error(t("editor.load_run_data_failed"));
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

      {/* 事件/输出子 Tab：tablist / aria-selected 等 tab 语义由 Radix 原语提供
          （改造前是两个裸 button，屏幕阅读器读不出「页签」也读不出选中项） */}
      <Tabs
        value={runRightTab}
        onValueChange={(value) => setRunRightTab(value as "events" | "output")}
        className="flex-1 min-h-0 gap-0"
      >
        <TabsList variant="line" className="w-full items-stretch gap-0 rounded-none border-b border-border-subtle p-0">
          <TabsTrigger value="events" className={RUN_TAB_TRIGGER}>
            {t("editor.events_tab", {
              count: selectedRunNodeId
                ? runEvents.filter((e) => e.node_id === selectedRunNodeId).length
                : runEvents.length,
            })}
          </TabsTrigger>
          <TabsTrigger value="output" className={RUN_TAB_TRIGGER}>
            {selectedRunNodeId
              ? t("editor.output_tab_selected", { nodeId: selectedRunNodeId })
              : t("editor.output_tab")}
          </TabsTrigger>
        </TabsList>

        {/* 事件列表 */}
        <TabsContent value="events" className="overflow-y-auto text-[11px]">
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
                        {/* 时间取当前 locale（§9.3）：固定 zh-CN 会让英文界面显示中文格式 */}
                        {new Date(evt.timestamp).toLocaleTimeString(i18n.language, {
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
        </TabsContent>

        {/* 节点输出 */}
        <TabsContent value="output" className="overflow-y-auto text-[11px]">
          {!selectedRunNodeId ? (
            <div className="py-5 text-center text-text-secondary">{t("editor.click_node_output")}</div>
          ) : nodeOutputLoading ? (
            <div className="py-5 text-center text-text-secondary">
              <InlineLoader size={14} />
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
        </TabsContent>
      </Tabs>
    </>
  );
}
