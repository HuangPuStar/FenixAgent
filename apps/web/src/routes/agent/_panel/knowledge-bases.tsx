import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { PanelRouteFallback } from "@/src/components/panel-route-fallback";

const Page = lazy(() =>
  import("@fenix/resource-knowledge/web").then((m) => ({
    default: m.AgentKnowledgeBasesPage,
  })),
);

export const Route = createFileRoute("/agent/_panel/knowledge-bases")({
  component: () => (
    <Suspense fallback={<PanelRouteFallback />}>
      <Page />
    </Suspense>
  ),
});
