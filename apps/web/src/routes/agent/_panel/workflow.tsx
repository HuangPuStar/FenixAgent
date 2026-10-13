import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { PanelRouteFallback } from "@/src/components/panel-route-fallback";

// 只经 lazy 进入：静态导入包入口会在路由壳上留下一条无法代码分割的静态边，整个包入口会被打进首屏 chunk
// （见前端规范 §2.4）。
//
// 壳里**没有标题区与动作**：页面级 `AppPage` + `AppHeader`（含「新建工作流」按钮）由包内页面渲染——标题区的
// 动作需要页面的弹窗状态，壳不做取数也不持有页面状态（前端规范 §2.7；同目录 `mcp.tsx` 的 tab 说明记了同一条
// 口径，`channels.tsx` / `skills.tsx` 等 12 个路由都是这一形态）。
const WorkflowListPage = lazy(() =>
  import("@fenix/resource-workflow-v2/web").then((m) => ({ default: m.WorkflowListPage })),
);

// 本壳必须自持 `Suspense`：缺了它，懒加载挂起会冒泡到父级布局壳（同目录 `_panel.tsx`）的边界，
// 那里的 fallback 是整屏 `Spinner variant="screen"`，会把整个 WebShell（侧栏、聊天保活）卸载重建，
// 用户看到的就是一次「整页刷新」。页面自身的 `loading` 只覆盖取数，接不住代码块加载。
export const Route = createFileRoute("/agent/_panel/workflow")({
  component: () => (
    <Suspense fallback={<PanelRouteFallback />}>
      <WorkflowListPage />
    </Suspense>
  ),
});
