import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { PanelRouteFallback } from "@/src/components/panel-route-fallback";
import { useAssemblyCapabilities } from "@/src/shell/AssemblyCapabilitiesProvider";
import { AssemblyRouteState } from "@/src/shell/AssemblyRouteGate";

const AdminTicketsPage = lazy(() =>
  import("@fenix/resource-tickets/web").then((m) => ({ default: m.AdminTicketsPage })),
);

/**
 * `/admin/tickets`：平台管理面的跨组织工单页（列表 + 就地打开的详情与全部写入口）。
 *
 * 路由壳的职责只有懒加载与装配能力边界：视图切换（列表 ⇄ 详情）、凭据门与写状态机都在
 * `@fenix/resource-tickets/web` 的 `AdminTicketsPage` 里（详情是同一路由内的就地视图，不是子路由——
 * 列表的筛选与页码因此不经过 URL 也不会丢）。
 *
 * 为什么除根守卫外还要在这里判一次部署能力：本文件在**任何**装配 profile 下都进路由表（TanStack 扫
 * `routes/`，与 profile 无关），而 `/admin/*` 不在任何贡献的 `routePrefixes` 里，`routeWebId` 对它返回
 * `undefined`，根守卫对 `undefined` 直接放行——此时手工输入地址会真的挂载业务页面并发起请求。未启用时
 * **不挂载**懒加载子树（连 chunk 都不会去取），展示与根守卫相同的「未启用」界面。
 *
 * `moduleId` 必须与 web contribution 的 `id` 逐字相同；文案复用宿主 `common` 字典的 `assembly.*`，不产生
 * 第二套「模块未启用」提示。同款落点与其移除条件见 `docs/arch/29-tickets.md` §9.2。
 */
export const Route = createFileRoute("/admin/tickets")({
  component: () => {
    const state = useAssemblyCapabilities();
    return (
      <AssemblyRouteState moduleId="tickets" state={state}>
        <Suspense fallback={<PanelRouteFallback />}>
          <AdminTicketsPage />
        </Suspense>
      </AssemblyRouteState>
    );
  },
});
