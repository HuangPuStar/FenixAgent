import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { PanelRouteFallback } from "@/src/components/panel-route-fallback";

const Page = lazy(() => import("@fenix/model-management/web").then((m) => ({ default: m.VerticalModelsPage })));

export const Route = createFileRoute("/agent/_panel/vertical-models")({
  component: () => (
    <Suspense fallback={<PanelRouteFallback />}>
      <Page />
    </Suspense>
  ),
});
