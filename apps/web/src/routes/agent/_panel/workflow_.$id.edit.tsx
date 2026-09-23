import { createFileRoute, useSearch } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { PanelRouteFallback } from "@/src/components/panel-route-fallback";

// 与下面同源的页面组件一样只经 lazy 进入：静态导入同一 barrel 会在路由壳上留下一条无法代码分割
// 的静态边，整个包入口会被打进首屏 chunk（见前端规范 §2.4）。
const WorkflowBreadcrumb = lazy(() =>
  import("@fenix/resource-workflow/web").then((m) => ({ default: m.WorkflowBreadcrumb })),
);
const WorkflowEditor = lazy(() => import("@fenix/resource-workflow/web").then((m) => ({ default: m.WorkflowEditor })));

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
    <Suspense fallback={<PanelRouteFallback />}>
      <WorkflowEditPage />
    </Suspense>
  ),
});
