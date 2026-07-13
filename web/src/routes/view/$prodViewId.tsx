import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { ErrorBoundary, type FallbackProps } from "react-error-boundary";
import { Button } from "@/components/ui/button";

const Page = lazy(() => import("../../pages/prod-view/ProdViewPage").then((m) => ({ default: m.ProdViewPage })));

/** ProdView 错误回退 UI：保留布局壳，提供重试按钮 */
function ProdViewErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  return (
    <div className="flex h-screen flex-col bg-[#f8fafc]">
      <div className="flex h-10 shrink-0 items-center border-b border-gray-200 bg-white px-4 text-sm">
        <span className="font-medium text-gray-700">ProdView</span>
        <span className="text-xs text-gray-400">FenixAgent</span>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-4">
        <p className="text-sm text-gray-500">{(error as Error)?.message ?? "页面加载失败"}</p>
        <Button variant="outline" onClick={resetErrorBoundary}>
          重试
        </Button>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/view/$prodViewId")({
  component: () => (
    <ErrorBoundary FallbackComponent={ProdViewErrorFallback}>
      <Suspense
        fallback={
          <div className="flex h-screen items-center justify-center">
            <div className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" />
          </div>
        }
      >
        <Page />
      </Suspense>
    </ErrorBoundary>
  ),
});
