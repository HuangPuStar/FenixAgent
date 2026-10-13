import { ErrorFallback } from "@fenix/ui-components/ui/error-fallback";
import { Spinner } from "@fenix/ui-components/ui/spinner";
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { ErrorBoundary, type FallbackProps } from "react-error-boundary";
import { useTranslation } from "react-i18next";

// 壳层实现落 `apps/web/src/shell/`（§1.6 T11d）：它承载品牌、布局与导航容器，不属于任何资源模块。
const DefaultAppShell = lazy(() => import("@/src/shell/DefaultAppShell").then((m) => ({ default: m.DefaultAppShell })));

// Agent 面板布局边界（§7.1 放置矩阵第 2 行）：包住 `/agent` 路由段下的整块外壳（侧栏 + 聊天保活 +
// 内容区出口）。边界放在 `Suspense` **外**——懒加载代码块被拒（chunk 404 / 断网）时 `Suspense` 接不住，
// 只有错误边界能接；壳自身形态仍按 §2.5 保持「单懒组件 + Suspense」，本批次只多这一层边界。
export const Route = createFileRoute("/agent/_panel")({
  component: () => {
    const { t } = useTranslation("agentPanel");
    return (
      <ErrorBoundary
        FallbackComponent={PanelErrorFallback}
        onError={(error, info) => console.error("[AgentPanel] 布局渲染失败", error, info)}
      >
        <Suspense fallback={<Spinner variant="screen" label={t("loading_agent_panel")} />}>
          <DefaultAppShell />
        </Suspense>
      </ErrorBoundary>
    );
  },
});

/** 面板布局降级 UI：与根边界同为整屏形态（这里崩溃时整个 Agent 页都不可用）。 */
function PanelErrorFallback({ resetErrorBoundary }: FallbackProps) {
  return <ErrorFallback resetErrorBoundary={resetErrorBoundary} variant="screen" />;
}
