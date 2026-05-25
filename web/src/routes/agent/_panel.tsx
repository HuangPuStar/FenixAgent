import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";

const AgentPanelLayout = lazy(() =>
  import("../../pages/agent-panel/AgentPanelLayout").then((m) => ({ default: m.AgentPanelLayout })),
);

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
        <AgentPanelLayout />
      </Suspense>
    );
  },
});
