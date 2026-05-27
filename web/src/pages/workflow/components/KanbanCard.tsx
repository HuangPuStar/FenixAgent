import { CheckCircle2, MoreHorizontal, Pause, Play, Trash2 } from "lucide-react";
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
}

const STATUS_STYLES: Record<string, { dot: string; color: string; bg: string }> = {
  ready: { dot: "bg-slate-400", color: "text-slate-600", bg: "bg-slate-50" },
  running: { dot: "bg-blue-500 animate-pulse", color: "text-blue-600", bg: "bg-blue-50" },
  suspended: { dot: "bg-amber-500", color: "text-amber-600", bg: "bg-amber-50" },
};

function dagStatusStyle(status: DagStatus) {
  if (status === "SUCCESS") return { dot: "bg-emerald-500", color: "text-emerald-600", bg: "bg-emerald-50" };
  return { dot: "bg-red-500", color: "text-red-600", bg: "bg-red-50" };
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
    .map(([k, v]) => `${k}=${String(v).substring(0, 15)}`)
    .join(", ");
  const remaining = Object.keys(params).length - 2;
  return remaining > 0 ? `${entries} +${remaining}` : entries;
}

export function KanbanCard({ job, onRefresh, onEditParams }: KanbanCardProps) {
  const { t } = useTranslation("kanban");
  const [loading, setLoading] = useState(false);

  const isTerminal = job.status === "completed";
  const style = isTerminal
    ? dagStatusStyle(job.lastDagStatus ?? "FAILED")
    : (STATUS_STYLES[job.status] ?? STATUS_STYLES.ready);

  const handleAction = async (action: () => Promise<unknown>) => {
    setLoading(true);
    try {
      await action();
      onRefresh();
    } catch (err) {
      console.error(err);
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const statusLabel = isTerminal
    ? t(`status_${(job.lastDagStatus ?? "failed").toLowerCase()}`)
    : t(`status_${job.status}`);

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
    <div className={`rounded-lg border text-xs transition-shadow hover:shadow-sm ${style.bg}`}>
      <div className="p-3 space-y-1.5">
        <div className="flex items-start justify-between gap-2">
          <span className="font-medium text-text-primary truncate text-[13px]">
            {job.workflowName ?? job.workflowId}
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="p-0.5 rounded hover:bg-black/5 flex-shrink-0" disabled={loading}>
                <MoreHorizontal size={14} className="text-text-secondary" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[120px]">
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

        <div className="text-text-secondary truncate" title={paramsSummary(job.params, t)}>
          {paramsSummary(job.params, t)}
        </div>

        <div className={`flex items-center gap-1.5 font-medium ${style.color}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
          {statusLabel}
        </div>

        <div className="text-text-secondary flex items-center gap-1">
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

      {primaryAction && PrimaryIcon && (
        <button
          type="button"
          onClick={() => handleAction(primaryAction.action)}
          disabled={loading}
          className={`w-full flex items-center justify-center gap-1.5 py-1.5 text-xs font-medium border-t transition-colors ${style.color} hover:bg-black/5 disabled:opacity-50`}
        >
          <PrimaryIcon size={13} />
          {primaryAction.label}
        </button>
      )}
    </div>
  );
}
