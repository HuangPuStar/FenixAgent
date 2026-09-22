import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { PanelRouteFallback } from "@/src/components/panel-route-fallback";

const Page = lazy(() =>
  import("@fenix/resource-memory/web").then((m) => ({
    default: m.MemoriesPage,
  })),
);

export const Route = createFileRoute("/agent/_panel/memories")({
  component: () => (
    <Suspense fallback={<PanelRouteFallback />}>
      <Page />
    </Suspense>
  ),
});
