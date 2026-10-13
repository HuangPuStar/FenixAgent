import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { PanelRouteFallback } from "@/src/components/panel-route-fallback";

const AlgorithmsPage = lazy(() =>
  import("@fenix/model-management/web").then((module) => ({
    default: module.AlgorithmsPage,
  })),
);

export const Route = createFileRoute("/agent/_panel/algorithms")({
  component: () => (
    <Suspense fallback={<PanelRouteFallback />}>
      <AlgorithmsPage />
    </Suspense>
  ),
});
