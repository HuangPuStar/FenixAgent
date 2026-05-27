import { Inbox } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { WorkflowJob } from "../../../api/workflow-jobs";
import { KanbanCard } from "./KanbanCard";

interface KanbanColumnProps {
  titleKey: string;
  jobs: WorkflowJob[];
  onRefresh: () => void;
  onEditParams: (job: WorkflowJob) => void;
}

export function KanbanColumn({ titleKey, jobs, onRefresh, onEditParams }: KanbanColumnProps) {
  const { t } = useTranslation("kanban");

  return (
    <div className="flex flex-col min-w-[260px] flex-1 border-r last:border-r-0">
      <div className="flex items-center justify-between px-3 py-2 border-b bg-surface-base flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-text-primary">{t(titleKey)}</span>
          <span className="text-[10px] font-medium text-text-secondary bg-surface-hover rounded-full px-1.5 py-0.5">
            {jobs.length}
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {jobs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-text-muted">
            <Inbox size={24} className="mb-1.5" />
            <span className="text-[11px]">{t(`empty_${titleKey.replace("col_", "")}`)}</span>
          </div>
        ) : (
          jobs.map((job) => <KanbanCard key={job.id} job={job} onRefresh={onRefresh} onEditParams={onEditParams} />)
        )}
      </div>
    </div>
  );
}
