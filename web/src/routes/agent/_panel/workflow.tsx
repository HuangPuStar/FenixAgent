import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router";
import { BarChart3, History, KanbanSquare, Loader, Pencil } from "lucide-react";
import { lazy, Suspense, useCallback } from "react";
import { useTranslation } from "react-i18next";

const WorkflowList = lazy(() =>
  import("../../../pages/workflow/WorkflowList").then((m) => ({ default: m.WorkflowList })),
);
const WorkflowRuns = lazy(() =>
  import("../../../pages/workflow/WorkflowRuns").then((m) => ({ default: m.WorkflowRuns })),
);
const WorkflowKanban = lazy(() =>
  import("../../../pages/workflow/WorkflowKanban").then((m) => ({ default: m.WorkflowKanban })),
);
const WorkflowStats = lazy(() =>
  import("../../../pages/workflow/WorkflowStats").then((m) => ({ default: m.WorkflowStats })),
);

function WorkflowTabPage() {
  const { t } = useTranslation("workflows");
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { tab?: string };
  const activeTab =
    search.tab === "kanban" ? "kanban" : search.tab === "runs" ? "runs" : search.tab === "stats" ? "stats" : "list";

  const onEditWorkflow = useCallback(
    (workflowId: string) => {
      void navigate({
        to: "/agent/workflow/$id/edit",
        params: { id: workflowId },
      });
    },
    [navigate],
  );

  const onViewVersions = useCallback(
    (workflowId: string) => {
      void navigate({
        to: "/agent/workflow/$id/versions",
        params: { id: workflowId },
      });
    },
    [navigate],
  );

  const onSelectRun = useCallback(
    (runId: string, workflowId?: string) => {
      if (workflowId) {
        void navigate({
          to: "/agent/workflow/$id/edit",
          params: { id: workflowId },
          search: { runId },
        });
      }
    },
    [navigate],
  );

  const tabs = [
    { id: "list" as const, label: t("page.tab_workflows"), icon: Pencil },
    { id: "kanban" as const, label: t("page.tab_kanban"), icon: KanbanSquare },
    { id: "runs" as const, label: t("page.tab_runs"), icon: History },
    { id: "stats" as const, label: t("page.tab_stats"), icon: BarChart3 },
  ];

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center px-6 h-9 border-b border-border-subtle bg-surface-base flex-shrink-0">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <Link
              key={tab.id}
              to="/agent/workflow"
              search={
                tab.id === "runs"
                  ? { tab: "runs" }
                  : tab.id === "kanban"
                    ? { tab: "kanban" }
                    : tab.id === "stats"
                      ? { tab: "stats" }
                      : {}
              }
              className={`flex items-center gap-1.5 px-3.5 h-full text-xs font-medium border-b-2 transition-colors ${
                isActive ? "text-brand border-brand" : "text-text-secondary border-transparent hover:text-text-primary"
              }`}
            >
              <Icon size={13} />
              {tab.label}
            </Link>
          );
        })}
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        {activeTab === "kanban" ? (
          <WorkflowKanban />
        ) : activeTab === "stats" ? (
          <WorkflowStats />
        ) : activeTab === "list" ? (
          <WorkflowList onEditWorkflow={onEditWorkflow} onViewVersions={onViewVersions} />
        ) : (
          <WorkflowRuns onSelectRun={onSelectRun} />
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute("/agent/_panel/workflow")({
  component: () => (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center">
          <Loader className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" />
        </div>
      }
    >
      <WorkflowTabPage />
    </Suspense>
  ),
});
