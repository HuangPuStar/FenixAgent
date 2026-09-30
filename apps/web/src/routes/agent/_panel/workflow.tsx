import { WORKFLOW_NS } from "@fenix/resource-workflow-v2/web/i18n";
import { AppHeader } from "@fenix/ui-components/layout/app-header";
import { AppPage } from "@fenix/ui-components/layout/app-page";
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { PanelRouteFallback } from "@/src/components/panel-route-fallback";

// 只经 lazy 进入：静态导入包入口会在路由壳上留下一条无法代码分割的静态边，整个包入口会被打进首屏 chunk
// （见前端规范 §2.4）。
const WorkflowListPage = lazy(() =>
  import("@fenix/resource-workflow-v2/web").then((m) => ({ default: m.WorkflowListPage })),
);

/**
 * `/agent/workflow`：工作流列表。
 *
 * 宿主侧只剩「页头 + 内容区」两层：列表、创建、重命名、删除与上游未就绪的引导全部在包内实现
 * （`@fenix/resource-workflow-v2/web`），宿主不再自己渲染「新建」按钮——包内列表页自带该动作，
 * 两处各放一个会让同一次新建出现两个入口。
 *
 * 运行记录 tab 已随自研引擎前端下线：运行与 trace 由上游画布承载，不再有独立的宿主路由与 tab 栏。
 */
function WorkflowListRoutePage() {
  const { t } = useTranslation(WORKFLOW_NS);

  return (
    <AppPage>
      <AppHeader title={t("page.workflow_title")} subtitle={t("page.workflow_subtitle")} />
      <Suspense fallback={<PanelRouteFallback size="sm" className="py-20" />}>
        <WorkflowListPage />
      </Suspense>
    </AppPage>
  );
}

export const Route = createFileRoute("/agent/_panel/workflow")({
  component: WorkflowListRoutePage,
});
