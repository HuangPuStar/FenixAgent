import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { PanelRouteFallback } from "@/src/components/panel-route-fallback";

const AgentManagementPage = lazy(() =>
  import("@fenix/agent-config/web").then((m) => ({
    default: m.AgentManagementPage,
  })),
);

// 本壳必须自持 `Suspense`：缺了它，懒加载挂起会冒泡到父级布局壳（同目录 `_panel.tsx`）的边界，
// 那里的 fallback 是整屏 `Spinner variant="screen"`，会把整个 WebShell（侧栏、聊天保活）卸载重建，
// 用户看到的就是一次「整页刷新」。页面自身的 `loading` 只覆盖取数，接不住代码块加载。
export const Route = createFileRoute("/agent/_panel/agents")({
  component: () => (
    <Suspense fallback={<PanelRouteFallback />}>
      <AgentManagementPage />
    </Suspense>
  ),
});
