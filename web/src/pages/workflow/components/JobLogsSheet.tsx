import { CheckCircle2, Circle, Loader2, ScrollText, XCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { type NodeOutput, workflowJobLogsApi } from "../../../api/workflow-job-logs";
import type { WorkflowJob } from "../../../api/workflow-jobs";

interface JobLogsSheetProps {
  job: WorkflowJob | null;
  open: boolean;
  onClose: () => void;
}

const STATUS_ICON: Record<NodeOutput["status"], React.ElementType> = {
  pending: Circle,
  running: Loader2,
  completed: CheckCircle2,
  failed: XCircle,
};

const STATUS_ICON_CLASS: Record<NodeOutput["status"], string> = {
  pending: "text-text-muted",
  running: "text-emerald-500 animate-spin",
  completed: "text-emerald-500",
  failed: "text-red-500",
};

function formatDuration(start: string | null, end: string | null): string {
  if (!start) return "–";
  const ms = (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.floor(ms / 1000);
  const min = Math.floor(s / 60);
  const sec = s % 60;
  return `${min}m${sec}s`;
}

export function JobLogsSheet({ job, open, onClose }: JobLogsSheetProps) {
  const { t } = useTranslation("kanban");
  const [nodes, setNodes] = useState<NodeOutput[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadOutputs = useCallback(async () => {
    if (!job) return;
    try {
      const data = await workflowJobLogsApi.getOutputs(job.id);
      setNodes(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error(err);
    }
  }, [job]);

  // Load outputs when opened
  useEffect(() => {
    if (!open || !job) {
      setNodes([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    loadOutputs().finally(() => setLoading(false));
  }, [open, job, loadOutputs]);

  // Auto-expand running nodes
  useEffect(() => {
    if (nodes.length === 0) return;
    const runningIds = nodes.filter((n) => n.status === "running").map((n) => n.nodeId);
    if (runningIds.length > 0) {
      setExpandedIds((prev) => {
        const next = new Set(prev);
        for (const id of runningIds) next.add(id);
        return next;
      });
    }
  }, [nodes]);

  // SSE for real-time events
  useEffect(() => {
    if (!open || !job) return;
    const es = workflowJobLogsApi.createLogsEventSource(job.id);
    es.onmessage = () => {
      loadOutputs();
    };
    return () => es.close();
  }, [open, job, loadOutputs]);

  // Poll for stdout updates on running nodes (2s)
  useEffect(() => {
    if (!open || !job) return;
    const hasRunning = nodes.some((n) => n.status === "running");
    if (!hasRunning) return;
    pollRef.current = setInterval(loadOutputs, 2000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [open, job, nodes, loadOutputs]);

  const toggleExpand = useCallback((nodeId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }, []);

  const completedCount = nodes.filter((n) => n.status === "completed" || n.status === "failed").length;
  const hasRunning = nodes.some((n) => n.status === "running");

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="w-[480px] sm:max-w-[480px] p-0 flex flex-col">
        <SheetHeader className="px-4 pt-4 pb-2 flex-shrink-0">
          <SheetTitle className="text-base">
            {job ? `${t("logs_title")} — ${job.workflowName ?? job.workflowId}` : t("logs_title")}
          </SheetTitle>
          {nodes.length > 0 && (
            <span className="text-xs text-text-muted">
              {t("logs_summary", { completed: completedCount, total: nodes.length })}
            </span>
          )}
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-1">
          {loading && nodes.length === 0 ? (
            <div className="flex items-center justify-center py-10 text-text-muted text-sm">
              <Loader2 size={16} className="mr-2 animate-spin" />
              {t("logs_loading")}
            </div>
          ) : nodes.length === 0 ? (
            <div className="flex items-center justify-center py-10 text-text-muted text-sm">
              <ScrollText size={16} className="mr-2 opacity-50" />
              {t("logs_no_run")}
            </div>
          ) : (
            nodes.map((node) => {
              const Icon = STATUS_ICON[node.status];
              const isRunning = node.status === "running";
              const expanded = expandedIds.has(node.nodeId);
              return (
                <div key={node.nodeId} className="rounded-lg border border-border-subtle overflow-hidden">
                  <button
                    type="button"
                    onClick={() => toggleExpand(node.nodeId)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-hover transition-colors"
                  >
                    <Icon size={14} className={STATUS_ICON_CLASS[node.status]} />
                    <span className="text-[12px] font-medium text-text-primary truncate flex-1">{node.nodeId}</span>
                    {node.nodeType && (
                      <span className="text-[10px] text-text-muted bg-surface-2 rounded px-1.5 py-px">
                        {node.nodeType}
                      </span>
                    )}
                    <span className="text-[10px] text-text-dim tabular-nums">
                      {formatDuration(node.startedAt, node.completedAt)}
                    </span>
                  </button>
                  {expanded && (
                    <div className="bg-gray-900 text-gray-100 font-mono text-[11px] leading-relaxed p-3 max-h-[200px] overflow-y-auto">
                      {node.stdout ? (
                        <pre className="whitespace-pre-wrap break-all">
                          {node.stdout}
                          {isRunning && (
                            <span className="inline-block w-2 h-3.5 bg-gray-100 ml-0.5 animate-pulse align-text-bottom" />
                          )}
                        </pre>
                      ) : (
                        <span className="text-gray-500 italic">{t("logs_no_output")}</span>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {hasRunning && (
          <div className="flex items-center gap-2 px-4 py-2.5 border-t border-border-subtle text-text-muted text-xs flex-shrink-0">
            <Loader2 size={12} className="animate-spin" />
            {t("logs_node_running")}…
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
