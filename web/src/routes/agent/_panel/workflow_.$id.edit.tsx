import { createFileRoute, useSearch } from "@tanstack/react-router";
import { Loader } from "lucide-react";
import { lazy, Suspense } from "react";
import { WorkflowBreadcrumb } from "../../../pages/workflow/WorkflowBreadcrumb";

const WorkflowEditor = lazy(() =>
  import("../../../pages/workflow/WorkflowEditor").then((m) => ({ default: m.WorkflowEditor })),
);

function WorkflowEditPage() {
  const { id } = Route.useParams();
  const search = useSearch({ strict: false }) as { runId?: string };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <WorkflowBreadcrumb workflowId={id} />
      <div className="flex-1 min-h-0 overflow-hidden">
        <WorkflowEditor workflowId={id} runId={search.runId} />
      </div>
    </div>
  );
}

export const Route = createFileRoute("/agent/_panel/workflow_/$id/edit")({
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
