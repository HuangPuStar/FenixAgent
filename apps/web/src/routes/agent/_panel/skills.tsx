import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { PanelRouteFallback } from "@/src/components/panel-route-fallback";

const Page = lazy(() => import("@fenix/resource-skill/web").then((m) => ({ default: m.AgentSkillsPage })));

export const Route = createFileRoute("/agent/_panel/skills")({
  component: () => (
    <Suspense fallback={<PanelRouteFallback />}>
      <Page />
    </Suspense>
  ),
});
