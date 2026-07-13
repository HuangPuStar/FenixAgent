import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { ErrorBoundary, type FallbackProps } from "react-error-boundary";
import { Button } from "@/components/ui/button";
import "../../pages/agent-panel/agent-panel.css";

const Page = lazy(() => import("../../pages/prod-view/ProdViewPage").then((m) => ({ default: m.ProdViewPage })));

/** ProdView 错误回退 UI：复用 agent-panel 布局 */
function ProdViewErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  return (
    <div className="agent-panel-layout !flex-col">
      <div className="flex h-10 shrink-0 items-center border-b border-border/40 bg-surface-1 px-4 text-sm">
        <span className="font-medium text-text-primary">ProdView</span>
        <span className="text-xs text-text-dim">FenixAgent</span>
      </div>
      <div className="agent-panel-body">
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6">
          <p className="text-sm text-text-muted">{(error as Error)?.message ?? "页面加载失败"}</p>
          <Button variant="outline" onClick={resetErrorBoundary}>
            重试
          </Button>
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/view/$prodViewId")({
  component: () => (
    <ErrorBoundary FallbackComponent={ProdViewErrorFallback}>
      <Suspense
        fallback={
          <div className="agent-panel-layout">
            <div className="agent-panel-body">
              <div className="flex h-full items-center justify-center">
                <div className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" />
              </div>
            </div>
          </div>
        }
      >
        <Page />
      </Suspense>
    </ErrorBoundary>
  ),
});
