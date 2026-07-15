import { createFileRoute, useSearch } from "@tanstack/react-router";
import { Loader } from "lucide-react";
import { lazy, Suspense } from "react";
import { WorkflowBreadcrumb } from "../../../pages/workflow/WorkflowBreadcrumb";
import { WorkflowPathContext } from "../../../pages/workflow/WorkflowPathContext";

/** 独立外部页面的工作流路径配置 */
const EXTERNAL_PATHS = {
  listPath: "/workflow",
  editPath: (id: string) => `/workflow/${id}/edit`,
  versionsPath: (id: string) => `/workflow/${id}/versions`,
  runsPath: "/workflow",
};

const WorkflowEditor = lazy(() =>
  import("../../../pages/workflow/WorkflowEditor").then((m) => ({ default: m.WorkflowEditor })),
);

function WorkflowEditPage() {
  const { id } = Route.useParams();
  const search = useSearch({ strict: false }) as { runId?: string };

  return (
    <WorkflowPathContext.Provider value={EXTERNAL_PATHS}>
      <div className="h-dvh flex flex-col">
        <WorkflowBreadcrumb workflowId={id} />
        <div className="flex-1 min-h-0 overflow-hidden">
          <WorkflowEditor workflowId={id} runId={search.runId} />
        </div>
      </div>
    </WorkflowPathContext.Provider>
  );
}

export const Route = createFileRoute("/workflow/$id/edit")({
  component: () => (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center">
          <Loader className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" />
        </div>
      }
    >
      <WorkflowEditPage />
    </Suspense>
  ),
});
