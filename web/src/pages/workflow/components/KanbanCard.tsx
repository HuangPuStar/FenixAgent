import { CheckCircle2, MoreHorizontal, Pause, Play, ScrollText, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
      className={`group border border-border-subtle border-l-[3px] bg-surface-elevated transition-colors hover:border-border ${accent}`}
    >
      <div className="px-2.5 py-2 space-y-1">
        {/* Name + menu */}
        <div className="flex items-center justify-between gap-1.5">
          <span className="font-medium text-text-primary truncate text-[11px] leading-tight">
            {job.workflowName ?? job.workflowId}
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="p-0.5 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-surface-hover flex-shrink-0"
                disabled={loading}
              >
                <MoreHorizontal size={12} className="text-text-muted" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[120px]">
              {(job.status === "running" || job.status === "completed" || job.status === "suspended") && (
                <DropdownMenuItem onClick={() => onViewLogs(job)}>
                  <ScrollText size={13} className="mr-1.5" /> {t("logs_view")}
                </DropdownMenuItem>
              )}
              {job.status === "ready" && (
                <DropdownMenuItem onClick={() => onEditParams(job)}>{t("card_edit_params")}</DropdownMenuItem>
              )}
              {(job.status === "ready" || job.status === "completed") && (
                <DropdownMenuItem
                  className="text-red-600"
                  onClick={() => handleAction(() => workflowJobsApi.delete(job.id))}
                >
                  <Trash2 size={13} className="mr-1.5" /> {t("card_delete")}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Params + Status row */}
        <div className="flex items-center justify-between gap-2">
          <div className="text-text-muted truncate text-[10px] font-mono" title={paramsSummary(job.params, t)}>
            {paramsSummary(job.params, t)}
          </div>
          <div
            className={`flex items-center gap-1 text-[10px] font-semibold uppercase whitespace-nowrap ${labelColor}`}
          >
            {isRunning && <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot} animate-pulse`} />}
            {!isRunning && <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} />}
            {statusLabel}
          </div>
        </div>

        {/* Meta */}
        <div className="text-text-dim text-[10px] flex items-center gap-1">
          {job.userName && <span>{t("card_created_by", { name: job.userName })}</span>}
          <span>·</span>
          <span>{relativeTime(job.createdAt, t)}</span>
          {job.runCount > 1 && (
            <>
              <span>·</span>
              <span>{t("card_run_count", { count: job.runCount })}</span>
            </>
          )}
        </div>
      </div>

      {/* Primary action */}
      {primaryAction && PrimaryIcon && (
        <button
          type="button"
          onClick={() => handleAction(primaryAction.action)}
          disabled={loading}
          className="w-full flex items-center justify-center gap-1 py-1 text-[10px] font-medium border-t border-border-subtle text-text-secondary hover:text-brand hover:bg-brand-subtle transition-colors disabled:opacity-50"
        >
          <PrimaryIcon size={12} />
          {primaryAction.label}
        </button>
      )}
    </div>
  );
}
