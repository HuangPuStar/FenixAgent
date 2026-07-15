import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Loader } from "lucide-react";
import { Suspense, useCallback } from "react";
import { WorkflowPathContext } from "../../../pages/workflow/WorkflowPathContext";
import { WorkflowVersions } from "../../../pages/workflow/WorkflowVersions";

/** 独立外部页面的工作流路径配置 */
const EXTERNAL_PATHS = {
  listPath: "/workflow",
  editPath: (id: string) => `/workflow/${id}/edit`,
  versionsPath: (id: string) => `/workflow/${id}/versions`,
  runsPath: "/workflow",
};

function WorkflowVersionsPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();

  const onEditWorkflow = useCallback(
    (workflowId: string) => {
      void navigate({
        to: "/workflow/$id/edit",
        params: { id: workflowId },
      });
    },
    [navigate],
  );

  return (
    <WorkflowPathContext.Provider value={EXTERNAL_PATHS}>
      <div className="h-dvh overflow-auto bg-[#f4f7fb] px-8 py-7 text-[#14213d] dark:bg-[#1a1d23]">
        <WorkflowVersions workflowId={id} onEditWorkflow={onEditWorkflow} />
      </div>
    </WorkflowPathContext.Provider>
  );
}

export const Route = createFileRoute("/workflow/$id/versions")({
  component: () => (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center">
          <Loader className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" />
        </div>
      }
    >
      <WorkflowVersionsPage />
    </Suspense>
  ),
});
