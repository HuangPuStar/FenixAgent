import { Button } from "@fenix/ui-components/ui/button";
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { ErrorBoundary, type FallbackProps } from "react-error-boundary";
import { useTranslation } from "react-i18next";
import { PanelRouteFallback } from "@/src/components/panel-route-fallback";
import { NS } from "@/src/i18n";

// 本路由不在 `DefaultAppShell` 之内，原先靠自己副作用导入 `@/src/shell/agent-panel.css` 取到聊天的
// `@keyframes`；该表已于 2026-09-28 退役，关键帧改由 `src/index.css` 顶部的 `@import` 承载——本文件
// 与壳内的挂载点都因 `main.tsx` 静态导入 `index.css` 而覆盖到，无需再导入样式表。

const Page = lazy(() => import("@fenix/resource-prod-view/web").then((m) => ({ default: m.ProdViewPage })));
// 分享页只解析实例身份，聊天容器由宿主注入：ChatArea 属宿主 Shell（§2.3），
// 资源包不得依赖聊天包实现，因此这里把宿主组件作为 `chatArea` prop 传入（CE 阶段 2 任务 1.6 T5b）。
const ChatArea = lazy(() => import("@/src/pages/agent-panel/ChatArea").then((m) => ({ default: m.ChatArea })));

/** ProdView 错误回退 UI：复用 agent-panel 布局 */
function ProdViewErrorFallback({ resetErrorBoundary }: FallbackProps) {
  const { t } = useTranslation(NS.COMMON);

  return (
    <div className="agent-panel-layout flex h-dvh w-full overflow-visible !flex-col">
      <div className="flex h-10 shrink-0 items-center border-b border-border/40 bg-surface-1 px-4 text-sm">
        <span className="font-medium text-text-primary">ProdView</span>
        <span className="text-xs text-text-dim">FenixAgent</span>
      </div>
      <div className="agent-panel-body flex min-w-0 min-h-0 flex-1 flex-col overflow-hidden bg-(--color-canvas)">
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6">
          <p className="text-sm text-text-muted">{t("load_failed")}</p>
          <Button variant="outline" onClick={resetErrorBoundary}>
            {t("retry")}
          </Button>
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/view/$prodViewId")({
  component: () => (
    <ErrorBoundary
      FallbackComponent={ProdViewErrorFallback}
      onError={(error) => console.error("[ProdView] 页面渲染失败", error)}
    >
      <Suspense
        fallback={
          <div className="agent-panel-layout flex h-dvh w-full overflow-visible">
            <div className="agent-panel-body flex min-w-0 min-h-0 flex-1 flex-col overflow-hidden bg-(--color-canvas)">
              <PanelRouteFallback />
            </div>
          </div>
        }
      >
        <Page chatArea={ChatArea} />
      </Suspense>
    </ErrorBoundary>
  ),
});
