import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Loader } from "lucide-react";
import { lazy, Suspense, useCallback } from "react";

// 页面实现属 owner 包，路由壳只做懒加载与边界（见前端规范 §2.4）。
const WorkflowVersions = lazy(() =>
  import("@fenix/resource-workflow/web").then((m) => ({ default: m.WorkflowVersions })),
);

function WorkflowVersionsPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();

  const onEditWorkflow = useCallback(
    (workflowId: string) => {
      void navigate({
        to: "/agent/workflow/$id/edit",
        params: { id: workflowId },
      });
    },
    [navigate],
  );

  return (
    <div className="h-full overflow-auto bg-[#f4f7fb] px-8 py-7 text-[#14213d] dark:bg-[#1a1d23]">
      <WorkflowVersions workflowId={id} onEditWorkflow={onEditWorkflow} />
    </div>
  );
}

export const Route = createFileRoute("/agent/_panel/workflow_/$id/versions")({
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
