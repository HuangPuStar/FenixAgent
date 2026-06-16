import { CheckCircle2, Pause, Play, ScrollText, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { DagStatus, WorkflowJob } from "../../../api/workflow-jobs";
import { workflowJobsApi } from "../../../api/workflow-jobs";

interface KanbanCardProps {
  job: WorkflowJob;
  onRefresh: () => void;
  onEditParams: (job: WorkflowJob) => void;
  onViewLogs: (job: WorkflowJob) => void;
}

const ACCENT: Record<string, string> = {
  ready: "border-l-slate-400",
  running: "border-l-emerald-500",
  suspended: "border-l-amber-400",
};

const DOT: Record<string, string> = {
  ready: "bg-slate-400",
  running: "bg-emerald-500",
  suspended: "bg-amber-400",
};

const LABEL: Record<string, string> = {
  ready: "text-text-secondary",
  running: "text-emerald-600",
  suspended: "text-amber-600",
};

function dagAccent(s: DagStatus) {
  return s === "SUCCESS" ? "border-l-emerald-400" : "border-l-red-400";
}
function dagDot(s: DagStatus) {
  return s === "SUCCESS" ? "bg-emerald-400" : "bg-red-400";
}
function dagLabel(s: DagStatus) {
  return s === "SUCCESS" ? "text-emerald-600" : "text-red-600";
}

function relativeTime(iso: string, t: (k: string, o?: Record<string, unknown>) => string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return t("card_relative_now");
  if (diff < 3600) return t("card_relative_minutes", { count: Math.floor(diff / 60) });
  if (diff < 86400) return t("card_relative_hours", { count: Math.floor(diff / 3600) });
  return t("card_relative_days", { count: Math.floor(diff / 86400) });
}

function paramsSummary(params: Record<string, unknown> | null, t: (k: string) => string): string {
  if (!params || Object.keys(params).length === 0) return t("no_params");
  const entries = Object.entries(params)
    .slice(0, 2)
    .map(([k, v]) => {
      const display = typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
      return `${k}=${display.substring(0, 15)}`;
    })
    .join(", ");
  const remaining = Object.keys(params).length - 2;
  return remaining > 0 ? `${entries} +${remaining}` : entries;
}

export function KanbanCard({ job, onRefresh, onEditParams, onViewLogs }: KanbanCardProps) {
  const { t } = useTranslation("kanban");
  const [loading, setLoading] = useState(false);

  const isTerminal = job.status === "completed";
  const isRunning = job.status === "running";

  const accent = isTerminal ? dagAccent(job.lastDagStatus ?? "FAILED") : (ACCENT[job.status] ?? ACCENT.ready);
  const dot = isTerminal ? dagDot(job.lastDagStatus ?? "FAILED") : (DOT[job.status] ?? DOT.ready);
  const labelColor = isTerminal ? dagLabel(job.lastDagStatus ?? "FAILED") : (LABEL[job.status] ?? LABEL.ready);

  const statusLabel = isTerminal
    ? t(`status_${(job.lastDagStatus ?? "failed").toLowerCase()}`)
    : t(`status_${job.status}`);

  const handleAction = async (action: () => Promise<unknown>) => {
    setLoading(true);
    try {
      await action();
      onRefresh();
    } catch (err) {
      console.error(err);
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const primaryAction =
    job.status === "ready" || job.status === "completed"
      ? {
          icon: Play,
          label: t(job.status === "ready" ? "card_run" : "card_rerun"),
          action: () => workflowJobsApi.run(job.id),
        }
      : job.status === "running"
        ? { icon: Pause, label: t("card_cancel"), action: () => workflowJobsApi.cancel(job.id) }
        : job.status === "suspended"
          ? {
              icon: CheckCircle2,
              label: t("card_approve"),
              action: async () => {
                const approvals = await workflowJobsApi.getPendingApprovals(job.id);
                if (approvals.length > 0) {
                  await workflowJobsApi.approve(job.id, approvals[0].nodeId, approvals[0].approvalToken);
                }
              },
            }
          : null;

  const PrimaryIcon = primaryAction?.icon;

  return (
    <div
      className={`group border border-border-light border-l-[3px] bg-surface-1 transition-colors hover:border-border-active ${accent}`}
    >
      <div className="px-2 py-1.5 space-y-0.5">
        {/* Name */}
        <span className="font-medium text-text-primary truncate text-[11px] leading-tight block">
          {job.workflowName ?? job.workflowId}
        </span>

        {/* Params + Status */}
        <div className="flex items-center justify-between gap-2">
          <div className="text-text-muted truncate text-[10px] font-mono" title={paramsSummary(job.params, t)}>
            {paramsSummary(job.params, t)}
          </div>
          <div
            className={`flex items-center gap-1 text-[10px] font-semibold uppercase whitespace-nowrap ${labelColor}`}
          >
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot} ${isRunning ? "animate-pulse" : ""}`} />
            {statusLabel}
          </div>
        </div>

        {/* Meta + inline actions */}
        <div className="flex items-center justify-between gap-1">
          <div className="text-text-dim text-[10px] flex items-center gap-1 truncate">
            {job.userName && <span>{t("card_created_by", { name: job.userName })}</span>}
            <span>·</span>
            <span>{relativeTime(job.createdAt, t)}</span>
          </div>
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
            {/* View logs — running/completed/suspended */}
            {(job.status === "running" || job.status === "completed" || job.status === "suspended") && (
              <button
                type="button"
                onClick={() => onViewLogs(job)}
                title={t("logs_view")}
                className="p-0.5 text-text-dim hover:text-brand"
              >
                <ScrollText size={11} />
              </button>
            )}
            {/* Edit params — ready */}
            {job.status === "ready" && (
              <button
                type="button"
                onClick={() => onEditParams(job)}
                title={t("card_edit_params")}
                className="p-0.5 text-text-dim hover:text-brand"
              >
                <Play size={11} />
              </button>
            )}
            {/* Delete — ready/completed */}
            {(job.status === "ready" || job.status === "completed") && (
              <button
                type="button"
                onClick={() => {
                  if (confirm(t("delete_confirm"))) handleAction(() => workflowJobsApi.delete(job.id));
                }}
                title={t("card_delete")}
                className="p-0.5 text-text-dim hover:text-red-500"
              >
                <Trash2 size={11} />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Primary action bar — only for run/cancel/approve */}
      {primaryAction && PrimaryIcon && (
        <button
          type="button"
          onClick={() => handleAction(primaryAction.action)}
          disabled={loading}
          className="w-full flex items-center justify-center gap-1 py-0.5 text-[10px] font-medium border-t border-border-light text-text-secondary hover:text-brand hover:bg-brand-subtle transition-colors disabled:opacity-50"
        >
          <PrimaryIcon size={10} />
          {primaryAction.label}
        </button>
      )}
    </div>
  );
}
