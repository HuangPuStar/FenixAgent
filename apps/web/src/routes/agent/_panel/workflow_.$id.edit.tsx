import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { PanelRouteFallback } from "@/src/components/panel-route-fallback";

// 与列表页同源：只经 lazy 进入，避免包入口被静态边拖进首屏 chunk（见前端规范 §2.4）。
const WorkflowCanvasHostPage = lazy(() =>
  import("@fenix/resource-workflow-v2/web").then((m) => ({ default: m.WorkflowCanvasHostPage })),
);

/**
 * `/agent/workflow/$id/edit`：画布宿主页（上游画布的 iframe 容器 + 握手与降级）。
 *
 * 路由段 `$id` 是 **上游 workflow ID**，不是本地注册表主键：画布深链与票据绑定都以它为准
 * （冻结 §7）。本地主键只用于列表页的增删改。
 *
 * 不经 `AppPage`：本页是全高画布，`AppPage` 的页面留白与滚动容器会把 iframe 压进一块可滚动的内层区域
 * （旧编辑器同款处理）。
 */
function WorkflowCanvasRoutePage() {
  const { id } = Route.useParams();

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <Suspense fallback={<PanelRouteFallback />}>
        <WorkflowCanvasHostPage upstreamWorkflowId={id} />
      </Suspense>
    </div>
  );
}

export const Route = createFileRoute("/agent/_panel/workflow_/$id/edit")({
  component: WorkflowCanvasRoutePage,
});
