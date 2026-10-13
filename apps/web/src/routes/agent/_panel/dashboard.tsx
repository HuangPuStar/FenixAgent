import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { PanelRouteFallback } from "@/src/components/panel-route-fallback";

const Page = lazy(() => import("@fenix/agent-config/web").then((m) => ({ default: m.AgentDashboardPage })));

export const Route = createFileRoute("/agent/_panel/dashboard")({
  component: () => (
    <Suspense fallback={<PanelRouteFallback />}>
      <Page />
    </Suspense>
  ),
});
