import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { PanelRouteFallback } from "@/src/components/panel-route-fallback";
import { useAssemblyCapabilities } from "@/src/shell/AssemblyCapabilitiesProvider";
import { AssemblyRouteState } from "@/src/shell/AssemblyRouteGate";

const Page = lazy(() => import("@fenix/resource-tickets/web").then((m) => ({ default: m.AgentTicketDetailPage })));

/**
 * `/agent/tickets/$projectId/$number`：工单详情。
 *
 * 文件名 `tickets_.…` 的尾下划线 = **阻断嵌套**（与 `workflow_.$id.edit.tsx` 同款约定）：列表页
 * `tickets.tsx` 渲染的是整页而不是布局出口，若让详情挂成它的子路由，列表就会变成详情的外壳。
 * 注意 `createFileRoute` 的字符串是含 `_` 的 route id，而 URL 路径不含 `_`。
 *
 * 参数由**本壳**用 `Route.useParams()` 读取后以 props 传给包内页面（与 `model-gateway-usage.$providerId.tsx`
 * 同款）：包内因此不需要认识宿主 route id，跨包契约只剩一个 props 形状。
 *
 * 部署能力判断与列表壳同因（见 `tickets.tsx` 的说明）：不含 tickets 贡献的产物里根守卫会放行 `undefined`
 * 归属，未启用时必须在挂载懒加载子树**之前**拦住。
 */
export const Route = createFileRoute("/agent/_panel/tickets_/$projectId/$number")({
  component: () => {
    const { projectId, number } = Route.useParams();
    const state = useAssemblyCapabilities();
    return (
      <AssemblyRouteState moduleId="tickets" state={state}>
        <Suspense fallback={<PanelRouteFallback />}>
          <Page projectId={projectId} number={number} />
        </Suspense>
      </AssemblyRouteState>
    );
  },
});
