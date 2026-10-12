import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { PanelRouteFallback } from "@/src/components/panel-route-fallback";
import { useAssemblyCapabilities } from "@/src/shell/AssemblyCapabilitiesProvider";
import { AssemblyRouteState } from "@/src/shell/AssemblyRouteGate";

const Page = lazy(() => import("@fenix/resource-tickets/web").then((m) => ({ default: m.AgentTicketsPage })));

/**
 * `/agent/tickets`：路由壳只做懒加载与边界，页面实现落在 owner 包。
 *
 * 为什么除根守卫外还要在这里判一次部署能力：本文件在**任何**装配 profile 下都进路由表（TanStack 扫
 * `routes/`，与 profile 无关），而不含 tickets 贡献的产物里，`routeWebId` 找不到归属会返回 `undefined`，
 * 根守卫对 `undefined` 直接放行——此时手工输入地址会真的挂载业务页面并发起请求。「关闭模块时无入口、
 * 无请求、手工输入地址显示未启用」这条验收因此落在本层：与产物无关地按 web 模块 ID 判一次，未启用时
 * **不挂载**懒加载子树（连 chunk 都不会去取）。
 *
 * `moduleId` 必须与 `webContribution` 的 `id` 逐字相同；文案复用宿主 `common` 字典的 `assembly.*`，
 * 与根守卫是同一个界面，不产生第二套「模块未启用」提示。
 */
export const Route = createFileRoute("/agent/_panel/tickets")({
  component: () => {
    const state = useAssemblyCapabilities();
    return (
      <AssemblyRouteState moduleId="tickets" state={state}>
        <Suspense fallback={<PanelRouteFallback />}>
          <Page />
        </Suspense>
      </AssemblyRouteState>
    );
  },
});
