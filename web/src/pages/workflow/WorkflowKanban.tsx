import { Loader, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { WorkflowJob } from "../../api/workflow-jobs";
import { workflowJobsApi } from "../../api/workflow-jobs";
import { useSession } from "../../lib/auth-client";
import { BoardSelector } from "./components/BoardSelector";
import { JobLogsSheet } from "./components/JobLogsSheet";
import { KanbanColumn } from "./components/KanbanColumn";
import { KanbanJobDialog } from "./components/KanbanJobDialog";

const COMPLETED_COLLAPSE_LIMIT = 10;

export function WorkflowKanban() {
  const { t } = useTranslation("kanban");
  const { data: session } = useSession();
  const currentUserId = session?.user?.id ?? "";
  const [jobs, setJobs] = useState<WorkflowJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAllCompleted, setShowAllCompleted] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editJob, setEditJob] = useState<WorkflowJob | null>(null);
  const [logsJob, setLogsJob] = useState<WorkflowJob | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const [boardId, setBoardId] = useState<string | null>(null);

  const loadJobs = useCallback(async () => {
    if (!boardId) return;
    try {
      setLoading(true);
      setError(null);
      const data = await workflowJobsApi.list(boardId);
      setJobs(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error(err);
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [boardId]);

  useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  // SSE 实时更新
  useEffect(() => {
    const es = workflowJobsApi.createEventSource();
    es.onmessage = () => {
      loadJobs();
    };
    return () => es.close();
  }, [loadJobs]);

  const grouped = useMemo(() => {
    const ready = jobs.filter((j) => j.status === "ready");
    const running = jobs.filter((j) => j.status === "running");
    const suspended = jobs.filter((j) => j.status === "suspended");
    const completed = jobs.filter((j) => j.status === "completed");
    return { ready, running, suspended, completed };
  }, [jobs]);

  const completedToShow = showAllCompleted ? grouped.completed : grouped.completed.slice(0, COMPLETED_COLLAPSE_LIMIT);
  const hasMoreCompleted = grouped.completed.length > COMPLETED_COLLAPSE_LIMIT;

  const handleEditParams = useCallback((job: WorkflowJob) => {
    setEditJob(job);
    setDialogOpen(true);
  }, []);

  const handleDialogClose = useCallback(() => {
    setDialogOpen(false);
    setEditJob(null);
  }, []);

  const handleViewLogs = useCallback((job: WorkflowJob) => {
    setLogsJob(job);
    setLogsOpen(true);
  }, []);

  // boardId 未选择时只渲染 toolbar（让 BoardSelector 触发 onSelect）
  if (loading && jobs.length === 0 && boardId) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader className="h-5 w-5 animate-spin text-text-muted" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-text-muted text-sm p-6">
        {t("load_failed", { error })}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-1 border-b border-border-subtle bg-surface-1 flex-shrink-0">
        <div className="flex items-center gap-1.5">
          <BoardSelector
            currentUserId={currentUserId}
            selectedBoardId={boardId}
            onSelect={setBoardId}
            onBoardsChange={loadJobs}
          />
          <Button
            type="button"
            size="sm"
            onClick={() => {
              setEditJob(null);
              setDialogOpen(true);
            }}
            disabled={!boardId}
            className="h-6 px-2 text-[10px]"
          >
            <Plus size={13} className="mr-0.5" />
            {t("dialog_create_title")}
          </Button>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={loadJobs}
          className="h-6 px-2 text-[10px] text-text-secondary"
        >
          <RefreshCw size={12} className="mr-0.5" />
          {t("refresh")}
        </Button>
      </div>

      {/* Board */}
      <div className="flex flex-1 min-h-0 overflow-hidden bg-surface-0">
        <KanbanColumn
          titleKey="col_ready"
          jobs={grouped.ready}
          onRefresh={loadJobs}
          onEditParams={handleEditParams}
          onViewLogs={handleViewLogs}
        />
        <KanbanColumn
          titleKey="col_running"
          jobs={grouped.running}
          onRefresh={loadJobs}
          onEditParams={handleEditParams}
          onViewLogs={handleViewLogs}
        />
        <KanbanColumn
          titleKey="col_suspended"
          jobs={grouped.suspended}
          onRefresh={loadJobs}
          onEditParams={handleEditParams}
          onViewLogs={handleViewLogs}
        />
        <div className="flex flex-col min-w-[260px] flex-1">
          <KanbanColumn
            titleKey="col_completed"
            jobs={completedToShow}
            onRefresh={loadJobs}
            onEditParams={handleEditParams}
            onViewLogs={handleViewLogs}
          />
          {hasMoreCompleted && !showAllCompleted && (
            <button
              type="button"
              onClick={() => setShowAllCompleted(true)}
              className="text-[11px] text-brand hover:text-brand-light py-2 text-center flex-shrink-0 transition-colors"
            >
              {t("completed_show_more", { count: grouped.completed.length - COMPLETED_COLLAPSE_LIMIT })}
            </button>
          )}
          {showAllCompleted && hasMoreCompleted && (
            <button
              type="button"
              onClick={() => setShowAllCompleted(false)}
              className="text-[11px] text-brand hover:text-brand-light py-2 text-center flex-shrink-0 transition-colors"
            >
              {t("completed_show_less")}
            </button>
          )}
        </div>
      </div>

      <KanbanJobDialog
        open={dialogOpen}
        onClose={handleDialogClose}
        editJob={editJob}
        onRefresh={loadJobs}
        boardId={boardId}
      />

      <JobLogsSheet
        job={logsJob}
        open={logsOpen}
        onClose={() => {
          setLogsOpen(false);
          setLogsJob(null);
        }}
      />
    </div>
  );
}
