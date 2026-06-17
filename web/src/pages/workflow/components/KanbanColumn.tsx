import { Inbox } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { WorkflowJob } from "../../../api/workflow-jobs";
import { KanbanCard } from "./KanbanCard";

interface KanbanColumnProps {
  titleKey: string;
  jobs: WorkflowJob[];
  onRefresh: () => void;
  onEditParams: (job: WorkflowJob) => void;
  onViewLogs: (job: WorkflowJob) => void;
}

export function KanbanColumn({ titleKey, jobs, onRefresh, onEditParams, onViewLogs }: KanbanColumnProps) {
  const { t } = useTranslation("kanban");

  return (
    <div className="flex flex-col min-w-[260px] flex-1 border-r border-border-subtle last:border-r-0">
      {/* Column header — uppercase section label */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border-light flex-shrink-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-semibold tracking-widest uppercase text-text-dim">{t(titleKey)}</span>
          {jobs.length > 0 && (
            <span className="text-[10px] font-semibold text-brand bg-brand-subtle rounded-none px-1.5 py-px leading-none">
              {jobs.length}
            </span>
          )}
        </div>
      </div>

      {/* Card list */}
      <div className="flex-1 overflow-y-auto space-y-px">
        {jobs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-6 text-text-dim">
            <Inbox size={16} className="mb-1 opacity-40" />
            <span className="text-[11px] tracking-wide">{t(`empty_${titleKey.replace("col_", "")}`)}</span>
          </div>
        ) : (
          jobs.map((job) => (
            <KanbanCard
              key={job.id}
              job={job}
              onRefresh={onRefresh}
              onEditParams={onEditParams}
              onViewLogs={onViewLogs}
            />
          ))
        )}
      </div>
    </div>
  );
}
