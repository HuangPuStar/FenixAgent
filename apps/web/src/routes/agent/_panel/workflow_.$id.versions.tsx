import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { PanelRouteFallback } from "@/src/components/panel-route-fallback";
import { useOpenWorkflowEditor } from "@/src/hooks/use-open-workflow-editor";

// 页面实现属 owner 包，路由壳只做懒加载与边界（见前端规范 §2.4）。
const WorkflowVersions = lazy(() =>
  import("@fenix/resource-workflow/web").then((m) => ({ default: m.WorkflowVersions })),
);

function WorkflowVersionsPage() {
  const { id } = Route.useParams();

  // 与列表页同一份落点（实现见 `@/src/hooks/use-open-workflow-editor`）
  const onEditWorkflow = useOpenWorkflowEditor();

  return (
    <div className="h-full overflow-auto bg-slate-100 px-8 py-7 text-slate-800 dark:bg-zinc-900">
      <WorkflowVersions workflowId={id} onEditWorkflow={onEditWorkflow} />
    </div>
  );
}

export const Route = createFileRoute("/agent/_panel/workflow_/$id/versions")({
  component: () => (
    <Suspense fallback={<PanelRouteFallback />}>
      <WorkflowVersionsPage />
    </Suspense>
  ),
});
