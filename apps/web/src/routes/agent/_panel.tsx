import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";

// 壳层实现落 `apps/web/src/shell/`（§1.6 T11d）：它承载品牌、布局与导航容器，不属于任何资源模块。
const DefaultAppShell = lazy(() => import("@/src/shell/DefaultAppShell").then((m) => ({ default: m.DefaultAppShell })));

export const Route = createFileRoute("/agent/_panel")({
  component: () => {
    const { t } = useTranslation("agentPanel");
    return (
      <Suspense
        fallback={
          <div className="flex h-screen flex-col items-center justify-center gap-3">
            <div className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" />
            <p className="text-sm text-text-muted">{t("loading_agent_panel")}</p>
          </div>
        }
      >
        <DefaultAppShell />
      </Suspense>
    );
  },
});
