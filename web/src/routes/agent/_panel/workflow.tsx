import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router";
import { History, Loader, Pencil, Plus } from "lucide-react";
import { lazy, Suspense, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { AgentPageHeader } from "../../../pages/agent-panel/shared/AgentPageHeader";

const WorkflowList = lazy(() =>
  import("../../../pages/workflow/WorkflowList").then((m) => ({ default: m.WorkflowList })),
);
const WorkflowRuns = lazy(() =>
  import("../../../pages/workflow/WorkflowRuns").then((m) => ({ default: m.WorkflowRuns })),
);

function TabContentFallback() {
  return (
    <div className="flex items-center justify-center py-20">
      <Loader className="h-6 w-6 animate-spin text-text-muted" />
    </div>
  );
}

function WorkflowTabPage() {
  const { t } = useTranslation("workflows");
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { tab?: string };
  const activeTab = search.tab === "runs" ? "runs" : "list";

  const [createTrigger, setCreateTrigger] = useState(0);

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

  const handleCreateClick = useCallback(() => {
    setCreateTrigger((n) => n + 1);
  }, []);

  const tabs = [
    { id: "list" as const, label: t("page.tab_workflows"), icon: Pencil, search: {} },
    { id: "runs" as const, label: t("page.tab_runs"), icon: History, search: { tab: "runs" } },
  ];

  return (
    <div className="h-full overflow-auto bg-[#f4f7fb] px-8 py-7 text-[#14213d] dark:bg-[#1a1d23]">
      <AgentPageHeader
        title={t("page.workflow_title")}
        subtitle={t("page.workflow_subtitle")}
        actions={
          <Button size="sm" onClick={handleCreateClick}>
            <Plus size={14} className="mr-1" />
            {t("list.create")}
          </Button>
        }
      />

      {/* 子 tab 栏：下划线式，嵌入页面内部 */}
      <div className="mb-4 flex items-center gap-1 border-b border-border-subtle">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <Link
              key={tab.id}
              to="/agent/workflow"
              search={tab.search}
              className={`flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium border-b-2 transition-colors ${
                isActive ? "text-brand border-brand" : "text-text-secondary border-transparent hover:text-text-primary"
              }`}
            >
              <Icon size={13} />
              {tab.label}
            </Link>
          );
        })}
      </div>

      {/* tab 内容区 — Suspense 在内容区内部，避免切换 tab 时顶栏闪烁 */}
      <Suspense fallback={<TabContentFallback />}>
        <div className="flex flex-1 flex-col min-h-0">
          {activeTab === "list" ? (
            <WorkflowList
              onEditWorkflow={onEditWorkflow}
              onViewVersions={onViewVersions}
              createRequested={createTrigger}
            />
          ) : (
            <WorkflowRuns onSelectRun={onSelectRun} />
          )}
        </div>
      </Suspense>
    </div>
  );
}

export const Route = createFileRoute("/agent/_panel/workflow")({
  component: WorkflowTabPage,
});
